export function createBranchesService({
  createRepositoryGitContext,
  cleanBranchName,
  normalizeUpstreamTarget,
  isValidCommitHash,
  isNotGitRepositoryError,
  runGitCommandOrThrow,
  getBranches,
  getUnpushedBranchCounts,
}) {
  const BRANCH_CREATION_SOURCE_RE = /^branch: Created from (.+)$/;

  /**
   * Parse a branch reflog (`git reflog show --format=%gs <branch>`) and return the
   * ref the branch was created from, when that source is itself a named ref.
   *
   * Returns null when the branch was created from `HEAD` (bare, as `git switch -c`
   * / `git checkout -b` without an explicit start point record) or a raw commit
   * (detached start): the original branch name is not recorded anywhere in that
   * case, and guessing a base from commit topology would be a heuristic, not an
   * answer. Callers should ask the user to pick a base instead.
   */
  function parseBranchCreationSource(reflogText) {
    const lines = String(reflogText || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    // Rebase records its destination as a commit, not a parent branch. The
    // creation ref is no longer evidence of the current base after restacking.
    if (lines.some((line) => /^rebase(?:\s|\()/.test(line))) return null;
    // Reflog lists newest entries first; the creation entry is the oldest one.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const match = lines[index].match(BRANCH_CREATION_SOURCE_RE);
      if (!match) continue;
      const source = match[1].trim();
      // Bare `HEAD` (`git switch -c` from the current branch) and `HEAD@{...}`
      // (detached start) both lack a named source; a raw commit hash does too.
      if (!source || /^HEAD(@|$)/.test(source) || /^[0-9a-f]{7,40}$/i.test(source)) {
        return null;
      }
      return source;
    }
    return null;
  }

  async function isOwnRemoteCopy(git, source, branchName) {
    const fullName = await git
      .raw(['rev-parse', '--symbolic-full-name', source])
      .then((value) => String(value || '').trim())
      .catch(() => '');
    if (!fullName.startsWith('refs/remotes/')) return false;
    const upstream = await git
      .raw(['rev-parse', '--symbolic-full-name', `refs/heads/${branchName}@{upstream}`])
      .then((value) => String(value || '').trim())
      .catch(() => '');
    if (upstream && fullName === upstream) return true;
    // Upstream may be unset; a remote ref with the branch's own name is still its copy.
    return fullName.slice('refs/remotes/'.length).split('/').slice(1).join('/') === branchName;
  }

  /**
   * Resolve the branch the given branch was created from, from its reflog.
   * Returns { base: null } when git has no authoritative record (clone, detached
   * start, reflog expired) — callers must not fall back to main/master.
   */
  async function getBranchBase(directory, branch) {
    const branchName = String(branch || '').trim();
    if (!branchName) {
      throw new Error('branch is required');
    }

    const { git } = await createRepositoryGitContext(directory);

    let reflog = '';
    try {
      reflog = await git.raw(['reflog', 'show', '--format=%gs', branchName]);
    } catch {
      return { base: null };
    }

    const source = parseBranchCreationSource(reflog);
    if (!source || source === branchName) {
      return { base: null };
    }

    const resolves = await git
      .raw(['rev-parse', '--verify', '--quiet', source])
      .then((value) => Boolean(String(value || '').trim()))
      .catch(() => false);
    if (!resolves) {
      return { base: null };
    }

    // `git switch feat` from a remote branch records "Created from
    // refs/remotes/origin/feat": the branch's own remote copy, not a parent.
    // Comparing against it hides every pushed commit.
    if (await isOwnRemoteCopy(git, source, branchName)) {
      return { base: null };
    }

    return { base: source };
  }

  async function createBranch(directory, branchName, options = {}) {
    const { git } = await createRepositoryGitContext(directory);

    try {
      await git.checkoutBranch(branchName, options.startPoint || 'HEAD');
      return { success: true, branch: branchName };
    } catch (error) {
      console.error('Failed to create branch:', error);
      throw error;
    }
  }

  // Deliberately not `--quiet`: simple-git resolves a quiet non-zero exit as
  // success, so the ref itself has to be echoed for the answer to mean anything.
  const gitRefExists = async (git, ref) => {
    try {
      const output = await git.raw(['show-ref', '--verify', ref]);
      return String(output).trim().length > 0;
    } catch {
      return false;
    }
  };

  /**
   * The branch selector lists remote-tracking branches beside local ones, so
   * picking `origin/main` means "work on main", not "detach HEAD at the remote's
   * commit" — which is what a literal checkout of a remote-tracking ref does.
   * Resolve such a pick to the local branch, creating it with tracking when it
   * does not exist yet. Anything we cannot resolve is checked out as requested,
   * leaving git's own DWIM behavior intact.
   */
  const resolveBranchCheckoutTarget = async (git, branchName) => {
    const requested = String(branchName || '').trim();
    if (!requested) {
      throw new Error('Branch name is required');
    }

    const asRequested = { branch: requested, remoteRef: null };

    if (await gitRefExists(git, `refs/heads/${requested}`)) {
      return asRequested;
    }

    const remoteRef = requested.replace(/^remotes\//, '');
    const remotes = await git.getRemotes();
    const remote = remotes.find((entry) => entry?.name && remoteRef.startsWith(`${entry.name}/`));
    if (!remote) {
      return asRequested;
    }

    const localBranch = remoteRef.slice(remote.name.length + 1);
    // `origin/HEAD` names no branch of its own; it is a pointer to one.
    if (!localBranch || localBranch === 'HEAD') {
      return asRequested;
    }

    // The branch list also carries branches that only `ls-remote` knows about
    // (#2098): they exist on the remote but were never fetched, so there is no
    // remote-tracking ref and a literal checkout fails with a pathspec error.
    // Fetch the single branch first so the tracking ref exists, then fall through
    // to the normal create-with-tracking path.
    if (!(await gitRefExists(git, `refs/remotes/${remoteRef}`))) {
      try {
        await git.fetch(remote.name, localBranch);
      } catch (error) {
        throw new Error(`Failed to fetch ${localBranch} from ${remote.name}: ${error?.message || error}`);
      }
      if (!(await gitRefExists(git, `refs/remotes/${remoteRef}`))) {
        throw new Error(`Branch ${localBranch} no longer exists on remote ${remote.name}`);
      }
    }

    const localExists = await gitRefExists(git, `refs/heads/${localBranch}`);
    return { branch: localBranch, remoteRef: localExists ? null : remoteRef };
  };

  async function checkoutBranch(directory, branchName) {
    const { git } = await createRepositoryGitContext(directory);

    try {
      const target = await resolveBranchCheckoutTarget(git, branchName);
      if (target.remoteRef) {
        await git.raw(['checkout', '-b', target.branch, '--track', target.remoteRef]);
      } else {
        await git.checkout(target.branch);
      }
      return { success: true, branch: target.branch };
    } catch (error) {
      console.error('Failed to checkout branch:', error);
      throw error;
    }
  }

  async function checkoutCommit(directory, hash) {
    if (!isValidCommitHash(hash)) {
      throw new Error('Invalid commit hash');
    }
    const { git } = await createRepositoryGitContext(directory);
    try {
      await git.checkout(hash);
      return { success: true };
    } catch (error) {
      console.error('Failed to checkout commit:', error);
      throw error;
    }
  }

  async function cherryPick(directory, hash) {
    if (!isValidCommitHash(hash)) {
      throw new Error('Invalid commit hash');
    }
    const { git } = await createRepositoryGitContext(directory);
    try {
      await git.raw(['cherry-pick', hash]);
      return { success: true, conflict: false };
    } catch (error) {
      const errorMessage = String(error?.message || error || '').toLowerCase();
      const isConflict =
        errorMessage.includes('conflict') ||
        errorMessage.includes('patch does not apply');

      if (isConflict) {
        const status = await git.status().catch(() => ({ conflicted: [] }));
        return {
          success: false,
          conflict: true,
          conflictFiles: status.conflicted || [],
        };
      }

      console.error('Failed to cherry-pick:', error);
      throw error;
    }
  }

  async function revertCommit(directory, hash) {
    if (!isValidCommitHash(hash)) {
      throw new Error('Invalid commit hash');
    }
    const { git } = await createRepositoryGitContext(directory);
    try {
      await git.raw(['revert', '--no-commit', hash]);
      return { success: true, conflict: false };
    } catch (error) {
      const errorMessage = String(error?.message || error || '').toLowerCase();
      const isConflict =
        errorMessage.includes('conflict') ||
        errorMessage.includes('revert failed');

      if (isConflict) {
        const status = await git.status().catch(() => ({ conflicted: [] }));
        return {
          success: false,
          conflict: true,
          conflictFiles: status.conflicted || [],
        };
      }

      console.error('Failed to revert commit:', error);
      throw error;
    }
  }

  async function resetToCommit(directory, hash, mode, force = false) {
    if (!isValidCommitHash(hash)) {
      throw new Error('Invalid commit hash');
    }
    const { git } = await createRepositoryGitContext(directory);

    if (mode === 'hard' && !force) {
      const status = await git.status();
      const isDirty = !status.isClean();
      if (isDirty) {
        throw new Error('Cannot hard reset: uncommitted changes in working tree. Stash or commit first, or use force.');
      }
    }

    try {
      await git.raw(['reset', `--${mode}`, hash]);
      return { success: true };
    } catch (error) {
      console.error('Failed to reset to commit:', error);
      throw error;
    }
  }

  async function deleteBranch(directory, branch, options = {}) {
    const { git } = await createRepositoryGitContext(directory);

    try {
      const branchName = branch.startsWith('refs/heads/')
        ? branch.substring('refs/heads/'.length)
        : branch;
      const args = ['branch', options.force ? '-D' : '-d', branchName];
      await git.raw(args);
      return { success: true };
    } catch (error) {
      console.error('Failed to delete branch:', error);
      throw error;
    }
  }

  async function renameBranch(directory, oldName, newName) {
    const { git, repoRoot } = await createRepositoryGitContext(directory);

    try {
      const normalizedOldName = cleanBranchName(String(oldName || '').trim());
      const normalizedNewName = cleanBranchName(String(newName || '').trim());

      const previousRemote = await git
        .raw(['config', '--get', `branch.${normalizedOldName}.remote`])
        .then((value) => String(value || '').trim())
        .catch(() => '');
      const previousMerge = await git
        .raw(['config', '--get', `branch.${normalizedOldName}.merge`])
        .then((value) => String(value || '').trim())
        .catch(() => '');

      // Use git branch -m command to rename the branch
      await git.raw(['branch', '-m', oldName, newName]);

      if (previousRemote && previousMerge && normalizedNewName) {
        const previousMergeBranch = cleanBranchName(previousMerge);
        const nextMergeBranch =
          previousMergeBranch === normalizedOldName
            ? normalizedNewName
            : previousMergeBranch;
        const upstream = normalizeUpstreamTarget(previousRemote, nextMergeBranch);

        if (upstream) {
          try {
            await runGitCommandOrThrow(
              repoRoot,
              ['branch', `--set-upstream-to=${upstream.full}`, normalizedNewName],
              `Failed to set upstream to ${upstream.full}`
            );
          } catch {
            // Leave tracking unset rather than writing config for a missing ref.
          }
        }
      }

      return { success: true, branch: newName };
    } catch (error) {
      console.error('Failed to rename branch:', error);
      throw error;
    }
  }

  async function getRemotes(directory) {
    const { git } = await createRepositoryGitContext(directory);

    try {
      const remotes = await git.getRemotes(true);

      return remotes.map((remote) => ({
        name: remote.name,
        fetchUrl: remote.refs.fetch,
        pushUrl: remote.refs.push
      }));
    } catch (error) {
      if (isNotGitRepositoryError(error)) {
        return [];
      }
      console.error('Failed to get remotes:', error);
      throw error;
    }
  }

  async function removeRemote(directory, options = {}) {
    const remoteName = String(options.remote || '').trim();
    if (!remoteName) {
      throw new Error('remote is required to remove a remote');
    }
    if (remoteName === 'origin') {
      throw new Error('Cannot remove origin remote');
    }

    const { git } = await createRepositoryGitContext(directory);

    try {
      await git.raw(['remote', 'remove', '--', remoteName]);
      return { success: true };
    } catch (error) {
      console.error('Failed to remove remote:', error);
      throw error;
    }
  }


  return {
    parseBranchCreationSource, getBranchBase, getBranches, getUnpushedBranchCounts,
    createBranch, checkoutBranch, checkoutCommit, cherryPick, revertCommit,
    resetToCommit, deleteBranch, renameBranch, getRemotes, removeRemote,
  };
}
