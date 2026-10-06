import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi, beforeAll } from 'vitest';
import { registerGitServiceTestSupport } from './service-test-support.js';
import { normalizeGitOutputPath } from '../../../../server/lib/git/output-path.js';
import {
  createWorktree,
  getWorktreeBootstrapStatus,
  populateWorktreeWithLockRecovery,
  previewWorktreeCreate,
  removeWorktree
} from '../../../../server/lib/git/service.js';
const { createTempDir, runGit, createRepositoryWithRemote, canRunGit } = registerGitServiceTestSupport({ afterEach, beforeAll, afterAll });

const readBranchConfig = (cwd, branch, key) => {
  try {
    return runGit(cwd, ['config', '--get', `branch.${branch}.${key}`]).trim();
  } catch {
    return '';
  }
};


describe('createWorktree', () => {
  it('waits for active bootstrap work before removing through a checkout alias', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    const setupStarted = path.join(dataHome, 'remove-race-started');
    const setupCompleted = path.join(dataHome, 'remove-race-completed');
    const setupScript = path.join(dataHome, 'remove-race.cjs');
    let createdPath = '';
    const bootstrapStore = {
      write: vi.fn(async (_directory, state) => state),
      read: vi.fn(async () => null),
      remove: vi.fn(async () => {
        expect(fs.existsSync(setupCompleted)).toBe(true);
        expect(fs.existsSync(createdPath)).toBe(true);
        return true;
      }),
    };
    process.env.XDG_DATA_HOME = dataHome;

    fs.writeFileSync(
      setupScript,
      `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(setupStarted)}, 'started'); setTimeout(() => fs.writeFileSync(${JSON.stringify(setupCompleted)}, 'completed'), 300);\n`,
    );

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);

      const created = await createWorktree(repo, {
        mode: 'new',
        branchName: 'feature/remove-bootstrap-race',
        worktreeName: 'remove-bootstrap-race',
        returnAfterDirectoryCreated: true,
        startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(setupScript)}`,
      }, {
        bootstrapStore,
        hydrateCheckout: async () => ({ status: 'not-needed', submodules: [], lfs: [] }),
      });
      createdPath = created.path;

      await expect.poll(() => fs.existsSync(setupStarted), { timeout: 5_000 }).toBe(true);
      let removalTarget = created.path;
      if (process.platform !== 'win32') {
        const aliasParent = createTempDir();
        const aliasRoot = path.join(aliasParent, 'worktrees');
        fs.symlinkSync(path.dirname(created.path), aliasRoot, 'dir');
        removalTarget = path.join(aliasRoot, path.basename(created.path));
      }
      let removalCompleted = false;
      const removal = removeWorktree(repo, { directory: removalTarget }, { bootstrapStore }).then(() => {
        removalCompleted = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(removalCompleted).toBe(false);
      await removal;

      expect(fs.existsSync(setupCompleted)).toBe(true);
      expect(fs.existsSync(created.path)).toBe(false);
      expect(bootstrapStore.remove).toHaveBeenCalledOnce();
      // Removal drops the record, so no stale pending state is left behind.
      await expect(getWorktreeBootstrapStatus(created.path)).resolves.toMatchObject({
        status: 'ready',
        phase: 'setup-ready',
      });
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('recovers from an unchanged stale index lock while populating a worktree', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    const worktree = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'core.autocrlf', 'false']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    fs.rmSync(worktree, { recursive: true, force: true });
    runGit(repo, ['worktree', 'add', '--no-checkout', '-b', 'feature/stale-lock', worktree, 'HEAD']);

    const lockPath = normalizeGitOutputPath(runGit(worktree, ['rev-parse', '--git-path', 'index.lock']).trim());
    fs.writeFileSync(lockPath, 'stale');

    await expect(populateWorktreeWithLockRecovery(worktree)).resolves.toBeUndefined();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readFileSync(path.join(worktree, 'README.md'), 'utf8')).toBe('# Test\n');
  });

  it('disables configured smudge filters while populating a worktree', async () => {
    if (!canRunGit() || process.platform === 'win32') return;

    const repo = createTempDir();
    const worktree = createTempDir();
    const marker = path.join(createTempDir(), 'smudge-ran');
    const filterScript = path.join(createTempDir(), 'smudge.cjs');
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'payload.txt filter=populate-smudge\n');
    fs.writeFileSync(path.join(repo, 'payload.txt'), 'checkout content\n');
    runGit(repo, ['add', '.gitattributes', 'payload.txt']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    fs.writeFileSync(
      filterScript,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdin.pipe(process.stdout);\n`,
    );
    runGit(repo, ['config', 'filter.populate-smudge.smudge', `${JSON.stringify(process.execPath)} ${JSON.stringify(filterScript)}`]);
    runGit(repo, ['config', 'filter.populate-smudge.required', 'true']);
    fs.rmSync(worktree, { recursive: true, force: true });
    runGit(repo, ['worktree', 'add', '--no-checkout', '-b', 'feature/filter-neutral', worktree, 'HEAD']);

    await expect(populateWorktreeWithLockRecovery(worktree)).resolves.toBeUndefined();

    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(path.join(worktree, 'payload.txt'), 'utf8')).toBe('checkout content\n');
  });

  it('preflights fast create branch-in-use failures before creating the candidate directory', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const repo = createTempDir();
      const worktree = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);
      const projectID = runGit(repo, ['rev-list', '--max-parents=0', '--all']).trim();

      fs.rmSync(worktree, { recursive: true, force: true });
      runGit(repo, ['worktree', 'add', '-b', 'feature/in-use', worktree, 'HEAD']);
      const canonicalWorktree = fs.realpathSync(worktree);

      const error = await createWorktree(repo, {
        mode: 'existing',
        existingBranch: 'feature/in-use',
        branchName: 'feature/in-use',
        worktreeName: 'feature-in-use',
        returnAfterDirectoryCreated: true,
      }).then(() => null, (error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message.replace(/\\/g, '/')).toBe(
        `Branch is already checked out in ${canonicalWorktree.replace(/\\/g, '/')}`,
      );

      const candidateDirectory = path.join(dataHome, 'opencode', 'worktree', projectID, 'feature-in-use');
      expect(fs.existsSync(candidateDirectory)).toBe(false);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('does not auto-track the remote start ref when creating a new branch from it', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const { repository } = createRepositoryWithRemote({ defaultBranch: 'main' });

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'openchamber/feature',
        worktreeName: 'feature-wt',
        startRef: 'remotes/origin/main',
        setUpstream: true,
        upstreamRemote: 'origin',
        upstreamBranch: 'openchamber/feature',
      });

      expect(created.branch).toBe('openchamber/feature');

      await expect.poll(
        () => getWorktreeBootstrapStatus(created.path).then((status) => status.status === 'ready' || status.status === 'failed'),
        { timeout: 5_000 }
      ).toBe(true);

      expect(readBranchConfig(created.path, 'openchamber/feature', 'remote')).toBe('');
      expect(readBranchConfig(created.path, 'openchamber/feature', 'merge')).toBe('');
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  }, 30_000);

  it('falls back to the remote start ref for upstream tracking when no explicit keys are given', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const { repository } = createRepositoryWithRemote({ defaultBranch: 'main' });

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'openchamber/fallback-wt',
        worktreeName: 'fallback-wt',
        startRef: 'remotes/origin/main',
        setUpstream: true,
      });

      await expect.poll(
        () => readBranchConfig(created.path, 'openchamber/fallback-wt', 'merge'),
        { timeout: 5_000 }
      ).toBe('refs/heads/main');
      expect(readBranchConfig(created.path, 'openchamber/fallback-wt', 'remote')).toBe('origin');
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  }, 30_000);

  it('falls back to the tracked local branch when the source fetch fails', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const { repository } = createRepositoryWithRemote({ defaultBranch: 'main' });
      runGit(repository, ['branch', '--set-upstream-to=origin/main', 'next']);
      runGit(repository, ['remote', 'set-url', 'origin', '/nonexistent/openchamber-unreachable.git']);

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'openchamber/stale-ref-wt',
        worktreeName: 'stale-ref-wt',
        startRef: 'remotes/origin/main',
      });

      expect(created.branch).toBe('openchamber/stale-ref-wt');
      expect(created.sourceFetchFailed).toBe(true);
      const expectedHead = runGit(repository, ['rev-parse', 'next']).trim();
      expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(expectedHead);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  }, 30_000);

  describe('from a local base branch', () => {
    const withDataHome = async (run) => {
      const previousXdgDataHome = process.env.XDG_DATA_HOME;
      process.env.XDG_DATA_HOME = createTempDir();
      try {
        await run();
      } finally {
        if (previousXdgDataHome === undefined) {
          delete process.env.XDG_DATA_HOME;
        } else {
          process.env.XDG_DATA_HOME = previousXdgDataHome;
        }
      }
    };

    // The repository sits on `next` with a local `main` tracking origin/main;
    // a teammate then pushes one commit to main that was never pulled.
    const createRepositoryBehindItsRemote = () => {
      const { remote, repository } = createRepositoryWithRemote({ defaultBranch: 'main' });
      runGit(repository, ['branch', '--track', 'main', 'origin/main']);
      const teammate = createTempDir();
      runGit(teammate, ['clone', remote, '.']);
      runGit(teammate, ['config', 'user.email', 'teammate@example.com']);
      runGit(teammate, ['config', 'user.name', 'Teammate']);
      fs.writeFileSync(path.join(teammate, 'pushed.txt'), 'pushed\n');
      runGit(teammate, ['add', 'pushed.txt']);
      runGit(teammate, ['commit', '-m', 'pushed later']);
      runGit(teammate, ['push', 'origin', 'HEAD:main']);
      return { repository, pushedHead: runGit(teammate, ['rev-parse', 'HEAD']).trim() };
    };

    it('starts from the freshly fetched upstream when nothing is unpublished', async () => {
      if (!canRunGit()) return;
      await withDataHome(async () => {
        const { repository, pushedHead } = createRepositoryBehindItsRemote();
        const localMain = runGit(repository, ['rev-parse', 'main']).trim();

        const created = await createWorktree(repository, {
          mode: 'new',
          branchName: 'openchamber/fresh-base',
          worktreeName: 'fresh-base',
          startRef: 'main',
        });

        expect(created.sourceFetchFailed).toBeUndefined();
        expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(pushedHead);
        expect(runGit(repository, ['rev-parse', 'main']).trim()).toBe(localMain);
      });
    }, 30_000);

    it('keeps the local branch when it has unpublished commits', async () => {
      if (!canRunGit()) return;
      await withDataHome(async () => {
        const { repository } = createRepositoryBehindItsRemote();
        runGit(repository, ['checkout', 'main']);
        fs.writeFileSync(path.join(repository, 'local.txt'), 'local\n');
        runGit(repository, ['add', 'local.txt']);
        runGit(repository, ['commit', '-m', 'unpublished']);
        runGit(repository, ['checkout', 'next']);
        const localMain = runGit(repository, ['rev-parse', 'main']).trim();

        const created = await createWorktree(repository, {
          mode: 'new',
          branchName: 'openchamber/local-base',
          worktreeName: 'local-base',
          startRef: 'main',
        });

        expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(localMain);
      });
    }, 30_000);

    it('keeps the local branch and reports it when the fetch fails', async () => {
      if (!canRunGit()) return;
      await withDataHome(async () => {
        const { repository } = createRepositoryBehindItsRemote();
        runGit(repository, ['remote', 'set-url', 'origin', '/nonexistent/openchamber-unreachable.git']);
        const localMain = runGit(repository, ['rev-parse', 'main']).trim();

        const created = await createWorktree(repository, {
          mode: 'new',
          branchName: 'openchamber/offline-base',
          worktreeName: 'offline-base',
          startRef: 'main',
        });

        expect(created.sourceFetchFailed).toBe(true);
        expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(localMain);
      });
    }, 30_000);
  });

  it('rejects creation from a remote start ref that was never fetched and cannot be fetched', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const { repository } = createRepositoryWithRemote({ defaultBranch: 'main' });
      runGit(repository, ['update-ref', '-d', 'refs/remotes/origin/main']);
      runGit(repository, ['remote', 'set-url', 'origin', '/nonexistent/openchamber-unreachable.git']);

      await expect(createWorktree(repository, {
        mode: 'new',
        branchName: 'openchamber/never-fetched-wt',
        worktreeName: 'never-fetched-wt',
        startRef: 'remotes/origin/main',
      })).rejects.toThrow(/does not appear to be a git repository|Could not read from remote repository/i);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  }, 30_000);
});
