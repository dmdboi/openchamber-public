// Run snapshots live under a private namespace so they never show up as
// branches or tags, yet stay reachable (and safe from gc) until deleted.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const RUN_SNAPSHOT_REF_PATTERN = /^refs\/openchamber\/runs\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const assertRunSnapshotRef = (ref) => {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (!RUN_SNAPSHOT_REF_PATTERN.test(value) || value.includes('..')) {
    throw new Error('Invalid snapshot ref');
  }
  return value;
};

const SNAPSHOT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'OpenChamber',
  GIT_AUTHOR_EMAIL: 'snapshot@openchamber.local',
  GIT_COMMITTER_NAME: 'OpenChamber',
  GIT_COMMITTER_EMAIL: 'snapshot@openchamber.local',
};

export function createWorktreeStateService({
  normalizeDirectoryPath,
  runGitCommand,
  runGitCommandOrThrow,
  buildGitEnv,
  createGit,
  isGitRepository,
  canonicalPath,
  resolveGitRepositoryRoot,
  resolveGitInternalPath,
  cleanBranchName,
  resolveWorktreeProjectContext,
}) {
  /**
   * Records the complete state of a worktree (committed, staged, unstaged and
   * untracked-but-not-ignored files) as a commit under `ref`. A throwaway index
   * is used, so the worktree's real index, HEAD, branch and files are untouched.
   */
  async function snapshotWorktree(directory, input = {}) {
    const worktreeDirectory = normalizeDirectoryPath(directory);
    if (!worktreeDirectory) {
      throw new Error('Worktree directory is required');
    }
    const ref = assertRunSnapshotRef(input?.ref);
    const head = (await runGitCommandOrThrow(worktreeDirectory, ['rev-parse', '--verify', 'HEAD'], 'Worktree has no HEAD commit')).stdout.trim();

    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-snapshot-'));
    const indexEnv = { GIT_INDEX_FILE: path.join(tempDir, 'index') };
    try {
      const run = async (args, message, env = indexEnv) => {
        // `env` replaces the whole environment, so start from the Git one.
        const result = await runGitCommand(worktreeDirectory, args, { env: { ...(await buildGitEnv()), ...env } });
        if (!result.success) {
          throw new Error(result.message || message);
        }
        return result.stdout.trim();
      };
      await run(['read-tree', head], 'Failed to prepare snapshot index');
      await run(['add', '-A'], 'Failed to collect worktree changes');
      const tree = await run(['write-tree'], 'Failed to write snapshot tree');
      const commit = await run(
        ['commit-tree', tree, '-p', head, '-m', 'OpenChamber run snapshot'],
        'Failed to write snapshot commit',
        { ...indexEnv, ...SNAPSHOT_IDENTITY_ENV },
      );
      await run(['update-ref', ref, commit], 'Failed to store snapshot ref', {});
      return { ref, commit, head };
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function isLinkedWorktree(directory) {
    const git = await createGit(directory);
    try {
      const [gitDir, gitCommonDir] = await Promise.all([
        git.raw(['rev-parse', '--git-dir']).then((output) => output.trim()),
        git.raw(['rev-parse', '--git-common-dir']).then((output) => output.trim())
      ]);
      return gitDir !== gitCommonDir;
    } catch (error) {
      console.error('Failed to determine worktree type:', error);
      return false;
    }
  }

  async function validateWorktreeDirectory(directory, worktreeRoot) {
    const directoryPath = normalizeDirectoryPath(directory);
    const rootPath = normalizeDirectoryPath(worktreeRoot);

    if (!directoryPath || !rootPath) {
      return {
        valid: false,
        insideWorktreeRoot: false,
        resolvedWorktreeRoot: null,
        resolvedCwd: null,
      };
    }

    const isRepo = await isGitRepository(directoryPath);
    if (!isRepo) {
      return {
        valid: false,
        insideWorktreeRoot: false,
        resolvedWorktreeRoot: null,
        resolvedCwd: null,
      };
    }

    const resolvedCwd = await canonicalPath(directoryPath);
    const resolvedRoot = await canonicalPath(rootPath);

    const inside = resolvedCwd.startsWith(resolvedRoot + path.sep) || resolvedCwd === resolvedRoot;

    return {
      valid: true,
      insideWorktreeRoot: inside,
      resolvedWorktreeRoot: resolvedRoot,
      resolvedCwd,
    };
  }

  async function canonicalizeWorktreeState(directory) {
    const directoryPath = normalizeDirectoryPath(directory);

    if (!directoryPath) {
      return {
        worktreeRoot: null,
        cwd: null,
        branch: null,
        headState: 'detached',
        worktreeStatus: 'not-a-repo',
        legacy: false,
        degraded: false,
        attentionReason: null,
      };
    }

    const isRepo = await isGitRepository(directoryPath);
    if (!isRepo) {
      return {
        worktreeRoot: null,
        cwd: null,
        branch: null,
        headState: 'detached',
        worktreeStatus: 'not-a-repo',
        legacy: false,
        degraded: false,
        attentionReason: null,
      };
    }

    const cwd = await canonicalPath(directoryPath);
    const git = await createGit(directoryPath);
    const repoRoot = await resolveGitRepositoryRoot(directoryPath, git).catch(() => directoryPath);

    let worktreeRoot = null;
    let worktreeStatus = 'ready';
    let headState = /** @type {'branch' | 'detached' | 'unborn'} */ ('branch');
    let branch = null;
    let attentionReason = /** @type {'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null} */ (null);

    try {
      const context = await resolveWorktreeProjectContext(directoryPath, { tolerateWorktreeRootConfigError: true });
      worktreeRoot = await canonicalPath(context.worktreeRoot);
    } catch {
      worktreeStatus = 'invalid';
    }

    try {
      const symbolicRef = await git.raw(['symbolic-ref', '-q', 'HEAD']).catch(() => '');
      if (symbolicRef.trim()) {
        headState = 'branch';
        branch = cleanBranchName(symbolicRef.trim());
      } else {
        const revParse = await git.raw(['rev-parse', 'HEAD']).catch(() => '');
        if (!revParse.trim()) {
          headState = 'unborn';
          branch = null;
        } else {
          headState = 'detached';
          branch = revParse.trim().slice(0, 7);
        }
      }
    } catch {
      headState = 'unborn';
      branch = null;
    }

    // Detect attention reasons from getStatus side-effects
    try {
      const status = await git.status(['-unormal']);
      if (status.current && (await git.raw(['rev-parse', '--verify', 'MERGE_HEAD']).then(() => true).catch(() => false))) {
        attentionReason = 'merge';
      } else {
        const rebaseMergePath = await resolveGitInternalPath(repoRoot, git, 'rebase-merge').catch(() => '');
        const rebaseApplyPath = await resolveGitInternalPath(repoRoot, git, 'rebase-apply').catch(() => '');
        const rebaseMerge = rebaseMergePath ? await fsp.stat(rebaseMergePath).then(() => true).catch(() => false) : false;
        const rebaseApply = rebaseApplyPath ? await fsp.stat(rebaseApplyPath).then(() => true).catch(() => false) : false;
        if (rebaseMerge || rebaseApply) {
          attentionReason = 'rebase';
        } else if (status.conflicted && status.conflicted.length > 0) {
          const cherryPickHeadPath = await resolveGitInternalPath(repoRoot, git, 'CHERRY_PICK_HEAD').catch(() => '');
          const revertHeadPath = await resolveGitInternalPath(repoRoot, git, 'REVERT_HEAD').catch(() => '');
          const cherryPickHead = cherryPickHeadPath ? await fsp.stat(cherryPickHeadPath).then(() => true).catch(() => false) : false;
          const revertHead = revertHeadPath ? await fsp.stat(revertHeadPath).then(() => true).catch(() => false) : false;
          if (cherryPickHead) attentionReason = 'cherry-pick';
          else if (revertHead) attentionReason = 'revert';
        }
      }
    } catch {
      // Status check failed — ignore
    }

    return {
      worktreeRoot,
      cwd,
      branch,
      headState,
      worktreeStatus,
      legacy: false,
      degraded: false,
      attentionReason,
    };
  }

  return { snapshotWorktree, isLinkedWorktree, validateWorktreeDirectory, canonicalizeWorktreeState };
}
