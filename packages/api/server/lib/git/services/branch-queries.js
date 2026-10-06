export function createBranchQueriesService({ createRepositoryGitContext }) {
  /**
   * `remote: 'local'` answers from local refs alone, as `git branch -a` does: the
   * callers that only need the checked-out branch and its upstream (publishing,
   * worktree creation) must not wait on every remote's network round trip.
   */
  async function getBranches(directory, { remote = 'live' } = {}) {
    const { git } = await createRepositoryGitContext(directory);

    try {
      const result = await git.branch();

      const allBranches = result.all;
      const remoteBranches = allBranches.filter(branch => branch.startsWith('remotes/'));
      // Read-only ref discovery, not a transfer: it never writes refs and never
      // takes the planned-operation path, so a branch pushed from elsewhere is
      // listed and a ref deleted on the remote is pruned without a fetch first.
      const activeRemoteBranches = remote === 'local'
        ? remoteBranches
        : await filterActiveRemoteBranches(git, directory, remoteBranches);
      const defaultBranches = await getRemoteDefaultBranches(git);

      return {
        all: [
          ...allBranches.filter(branch => !branch.startsWith('remotes/')),
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

  /**
   * Counts locally unpushed commits for a small caller-supplied set of local
   * branches. This deliberately reads only local refs: the branch picker calls
   * it when opened, never polls, and never fetches a remote behind the user's
   * back. Unknown, remote, and upstream-less branches are omitted.
   */
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
    let defaults = {};

    try {
      const refs = await git.raw([
        'for-each-ref',
        '--format=%(refname) %(symref)',
        'refs/remotes',
      ]);
      defaults = Object.fromEntries(
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
      defaults = {};
    }

    return defaults;
  }

  // What each remote reported for its heads, per repository and remote. A
  // repository with many remotes paid one network round trip per remote on every
  // branch listing, and the Git panel lists branches several times per action.
  // An answer is reused while it is fresh and the local remote-tracking refs of
  // that remote are unchanged: a push or fetch from here changes them, so it
  // reads again. Concurrent listings share one round trip.
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
    // A remote that did not answer is asked again next time.
    heads.catch(() => { if (remoteHeadsCache.get(key) === entry) remoteHeadsCache.delete(key); });
    return heads;
  };

  async function filterActiveRemoteBranches(git, directory, remoteBranches) {
    try {
      const remotes = await git.getRemotes(true);
      const branchesByRemote = new Map();

      // A remote that did not answer says nothing about its branches. Dropping
      // them would turn "we could not ask" into "these branches are gone", and
      // callers use this list to decide whether a base branch exists at all — so
      // offline would silently remove comparisons that work perfectly well
      // against the local remote-tracking refs.
      const unreachableRemotes = new Set();

      await Promise.all(remotes.map(async (remote) => {
        try {
          const localRefs = remoteBranches.filter((branch) => branch.startsWith(`remotes/${remote.name}/`));
          branchesByRemote.set(remote.name, await readRemoteHeads(git, directory, remote, localRefs));
        } catch {
          unreachableRemotes.add(remote.name);
        }
      }));

      const activeBranches = remoteBranches.filter(remoteBranch => {
        const match = remoteBranch.match(/^remotes\/[^\/]+\/(.+)$/);
        if (!match) return false;
        const remoteName = remoteBranch.split('/')[1];
        const branchName = match[1];
        if (unreachableRemotes.has(remoteName)) return true;
        return branchesByRemote.get(remoteName)?.has(branchName) ?? false;
      });

      // A branch pushed to the remote that was never fetched locally has no
      // remote-tracking ref, so `git branch` never reports it — but ls-remote
      // just told us it exists. Add those so a freshly pushed branch shows up
      // without requiring a fetch first (#2098). Unreachable remotes have no
      // ls-remote data and therefore add nothing here; their local view above
      // is preserved unchanged.
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
