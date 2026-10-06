import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import simpleGit from 'simple-git';
import { createWorktreeBootstrapStore } from '../../../../server/lib/git/worktree-bootstrap-storage.js';
import { loadSourceSections, parseSource, sourceKey } from '../../../../server/lib/walkthrough/sources.js';
import { registerGitRoutes } from '../../../../server/lib/git/routes.js';
import { normalizeGitOutputPath } from '../../../../server/lib/git/output-path.js';

import {
  getCurrentIdentity,
  checkoutBranch,
  checkoutCommit,
  cherryPick,
  commit,
  createWorktree,
  getWorktreeBootstrapStatus,
  getBranches,
  getRepositoryRemoteUrls,
  parseRemoteListing,
  getRepositoryRoot,
  getUnpushedBranchCounts,
  getRangeDiff,
  getBranchBase,
  getCommitDiff,
  getCommitFiles,
  getLog,
  getStatus,
  getTrackingBranch,
  getWorktrees,
  isGitRepository,
  observeWorktreeTopology,
  populateWorktreeWithLockRecovery,
  previewWorktreeCreate,
  removeWorktree,
  snapshotWorktree,
  resolvePrimaryWorktreeRoot,
  resolveWorktreeTopLevel,
  resetToCommit,
  resolveBaseRefForLog,
  revertCommit,
  setLocalIdentity,
  clearLocalIdentity,
  configureRepositoryTransport,
  getGlobalIdentity,
  stageFiles,
  subscribeWorktreeTopologyChanges,
  unstageFiles,
  applyHunk,
  getDiff,
  getPathDiff,
  revertFile,
  getUntrackedDiffs,
  getFileDiff,
  hasLocalIdentity,
  validateWorktreeCreate,
  parseBranchCreationSource,
  getRangeFiles,
  inspectContributorCheckoutActions,
  getConflictDetails,
  continueMerge,
  continueRebase,
  merge,
  rebase,
  removeRemote,
} from '../../../../server/lib/git/service.js';

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

const tempDirs = [];

/** Create a temp dir and register it for afterEach cleanup. */
const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-service-'));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.platform === 'win32'
      ? { ...process.env, MSYS: [process.env.MSYS, 'noglob'].filter(Boolean).join(' ') }
      : process.env,
  });

const readBranchConfig = (cwd, branch, key) => {
  try {
    return runGit(cwd, ['config', '--get', `branch.${branch}.${key}`]).trim();
  } catch {
    return '';
  }
};

/**
 * A repository on `next` whose only remote publishes `defaultBranch` and has it
 * recorded as that remote's HEAD — the shape of every repository whose default
 * branch is not one of the conventional names.
 */
const createRepositoryWithRemote = ({ remoteName = 'origin', defaultBranch = 'react' } = {}) => {
  const remote = createTempDir();
  const repository = createTempDir();
  runGit(remote, ['init', '--bare', `--initial-branch=${defaultBranch}`]);
  runGit(repository, ['init', '-b', 'next']);
  runGit(repository, ['config', 'user.email', 'test@example.com']);
  runGit(repository, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n');
  runGit(repository, ['add', 'README.md']);
  runGit(repository, ['commit', '-m', 'init']);
  runGit(repository, ['remote', 'add', remoteName, remote]);
  runGit(repository, ['push', remoteName, `HEAD:${defaultBranch}`]);
  runGit(repository, ['fetch', remoteName]);
  runGit(repository, ['remote', 'set-head', remoteName, '--auto']);
  return { remote, repository };
};

const canRunGit = () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-check-'));
  try {
    execFileSync('git', ['--version'], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Tests must not depend on developer-machine git state. A global
// excludesFile (say `node_modules/` in the developer's ~/.gitignore) makes a
// fixture directory vanish from status on that machine and nowhere else, so
// every git invocation in this file — the fixtures' runGit and the service's
// own spawns, which inherit process.env — reads an empty global config
// instead. Fixture repos set their identity locally, so nothing else changes.
// Registered outside tempDirs on purpose: afterEach would delete a registered
// dir after the first test.
const emptyGlobalGitConfig = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-service-config-')),
  'git-config',
);
fs.writeFileSync(emptyGlobalGitConfig, '');

let savedGitConfigGlobal;

beforeAll(() => {
  savedGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = emptyGlobalGitConfig;
});

afterAll(() => {
  if (savedGitConfigGlobal === undefined) {
    delete process.env.GIT_CONFIG_GLOBAL;
  } else {
    process.env.GIT_CONFIG_GLOBAL = savedGitConfigGlobal;
  }
  fs.rmSync(path.dirname(emptyGlobalGitConfig), { recursive: true, force: true });
});

/**
 * Create a temp repo using simple-git (for tests that need its assertion API).
 * The dir is registered in tempDirs so afterEach handles cleanup automatically.
 */
async function createTempRepo() {
  const tmpDir = createTempDir();
  const git = simpleGit(tmpDir);
  await git.init();
  await git.addConfig('user.name', 'Test User', false, 'local');
  await git.addConfig('user.email', 'test@example.com', false, 'local');
  await git.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { tmpDir, git };
}

// ---------------------------------------------------------------------------
// resolveBaseRefForLog
// ---------------------------------------------------------------------------

describe('snapshotWorktree', () => {
  const createSnapshotRepo = () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.env\n');
    runGit(repo, ['add', 'README.md', '.gitignore']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    return repo;
  };

  it('captures staged, unstaged and untracked changes without touching the worktree', async () => {
    if (!canRunGit()) return;
    const repo = createSnapshotRepo();
    const head = runGit(repo, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(repo, 'README.md'), '# Changed\n');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');
    runGit(repo, ['add', 'staged.txt']);
    fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
    fs.writeFileSync(path.join(repo, 'secret.env'), 'TOKEN=1\n');
    const statusBefore = runGit(repo, ['status', '--porcelain']);

    const ref = 'refs/openchamber/runs/group-1/ses_abc';
    const result = await snapshotWorktree(repo, { ref });

    expect(result).toMatchObject({ ref, head });
    expect(runGit(repo, ['rev-parse', ref]).trim()).toBe(result.commit);
    expect(runGit(repo, ['rev-parse', `${result.commit}^`]).trim()).toBe(head);
    const files = runGit(repo, ['ls-tree', '-r', '--name-only', result.commit]).trim().split('\n').sort();
    expect(files).toEqual(['.gitignore', 'README.md', 'new.txt', 'staged.txt']);
    expect(runGit(repo, ['show', `${result.commit}:README.md`])).toBe('# Changed\n');

    expect(runGit(repo, ['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(runGit(repo, ['status', '--porcelain'])).toBe(statusBefore);
    expect(runGit(repo, ['branch', '--list']).trim()).toBe('* main');
  });

  it('rejects refs outside the private namespace', async () => {
    if (!canRunGit()) return;
    const repo = createSnapshotRepo();
    await expect(snapshotWorktree(repo, { ref: 'refs/heads/main' })).rejects.toThrow('Invalid snapshot ref');
    await expect(snapshotWorktree(repo, { ref: 'refs/openchamber/runs/../heads' })).rejects.toThrow('Invalid snapshot ref');
  });

});

// ---------------------------------------------------------------------------
// checkoutCommit
// ---------------------------------------------------------------------------
