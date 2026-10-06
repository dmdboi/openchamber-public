export function createBranchQueriesService({ createRepositoryGitContext }) {
  /**
   * `remote: 'local'` answers from local refs alone, as `git branch -a` does.
   * Callers that only need the checked-out branch and upstream must not wait on
   * every remote's network round trip.
   */
  async function getBranches(directory, { remote = 'live' } = {}) {
    const { git } = await createRepositoryGitContext(directory);

    try {
      const result = await git.branch();
      const allBranches = result.all;
      const remoteBranches = allBranches.filter((branch) => branch.startsWith('remotes/'));
      const activeRemoteBranches = remote === 'local'
        ? remoteBranches
        : await filterActiveRemoteBranches(git, directory, remoteBranches);
      const defaultBranches = await getRemoteDefaultBranches(git);

      return {
        all: [
          ...allBranches.filter((branch) => !branch.startsWith('remotes/')),
          ...activeRemoteBranches,
        ],
        current: result.current,
        branches: result.branches,
        defaultBranches,
      };
    } catch (error) {
      console.error('Failed to get branches:', error);
      throw error;
    }
  }

  /** Counts unpushed commits from local refs only; this never fetches. */
  async function getUnpushedBranchCounts(directory, branchNames) {
    const { git } = await createRepositoryGitContext(directory);
    const requested = [...new Set(Array.isArray(branchNames) ? branchNames : [])]
      .filter((name) => typeof name === 'string' && name.length > 0)
      .slice(0, 5);
    if (requested.length === 0) return { counts: {} };

    const local = new Set((await git.branchLocal()).all);
    const counts = {};
    await Promise.all(requested.map(async (branch) => {
      if (!local.has(branch)) return;
      const upstream = await git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`])
        .then((value) => value.trim())
        .catch(() => '');
      if (!upstream) return;
      const count = await git.raw(['rev-list', '--count', `${upstream}..${branch}`])
        .then((value) => Number.parseInt(value.trim(), 10))
        .catch(() => 0);
      if (Number.isFinite(count) && count > 0) counts[branch] = count;
    }));
    return { counts };
  }

  async function getRemoteDefaultBranches(git) {
    try {
      const refs = await git.raw([
        'for-each-ref',
        '--format=%(refname) %(symref)',
        'refs/remotes',
      ]);
      return Object.fromEntries(
        refs.trim().split('\n').flatMap((line) => {
          const [ref, symbolicRef] = line.split(' ');
          const match = ref.match(/^refs\/remotes\/([^/]+)\/HEAD$/);
          const prefix = match ? `refs/remotes/${match[1]}/` : '';
          return match && typeof symbolicRef === 'string' && symbolicRef.startsWith(prefix)
            ? [[match[1], symbolicRef.slice(prefix.length)]]
            : [];
        })
      );
    } catch {
      return {};
    }
  }

  // Cache one remote-head answer per repository and remote. Tracking-ref
  // changes invalidate the answer and concurrent listings share the request.
  const REMOTE_HEADS_TTL_MS = 30_000;
  const remoteHeadsCache = new Map();

  const readRemoteHeads = (git, directory, remote, localRefs) => {
    const key = `${directory}\0${remote.name}\0${remote.refs?.fetch ?? ''}`;
    const localKey = localRefs.join('\n');
    const cached = remoteHeadsCache.get(key);
    if (cached && cached.localKey === localKey && Date.now() - cached.at < REMOTE_HEADS_TTL_MS) return cached.heads;
    const heads = git.raw(['ls-remote', '--heads', '--', remote.name]).then((output) => {
      const names = new Set();
      for (const line of output.trim().split('\n')) {
        if (line.includes('\trefs/heads/')) names.add(line.split('\t')[1].replace('refs/heads/', ''));
      }
      return names;
    });
    const entry = { at: Date.now(), localKey, heads };
    remoteHeadsCache.set(key, entry);
    heads.catch(() => { if (remoteHeadsCache.get(key) === entry) remoteHeadsCache.delete(key); });
    return heads;
  };

  async function filterActiveRemoteBranches(git, directory, remoteBranches) {
    try {
      const remotes = await git.getRemotes(true);
      const branchesByRemote = new Map();
      const unreachableRemotes = new Set();

      await Promise.all(remotes.map(async (remote) => {
        try {
          const localRefs = remoteBranches.filter((branch) => branch.startsWith(`remotes/${remote.name}/`));
          branchesByRemote.set(remote.name, await readRemoteHeads(git, directory, remote, localRefs));
        } catch {
          unreachableRemotes.add(remote.name);
        }
      }));

      const activeBranches = remoteBranches.filter((remoteBranch) => {
        const match = remoteBranch.match(/^remotes\/[^/]+\/(.+)$/);
        if (!match) return false;
        const remoteName = remoteBranch.split('/')[1];
        if (unreachableRemotes.has(remoteName)) return true;
        return branchesByRemote.get(remoteName)?.has(match[1]) ?? false;
      });

      const seenBranches = new Set(activeBranches);
      for (const [remoteName, actualRemoteBranches] of branchesByRemote) {
        for (const branchName of actualRemoteBranches) {
          const qualifiedBranch = `remotes/${remoteName}/${branchName}`;
          if (!seenBranches.has(qualifiedBranch)) {
            seenBranches.add(qualifiedBranch);
            activeBranches.push(qualifiedBranch);
          }
        }
      }
      return activeBranches;
    } catch (error) {
      console.warn('Failed to filter active remote branches, returning all:', error.message);
      return remoteBranches;
    }
  }

  return { getBranches, getUnpushedBranchCounts };
}
