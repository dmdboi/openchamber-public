import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi, beforeAll } from 'vitest';
import { registerGitServiceTestSupport } from './service-test-support.js';
import { createWorktreeBootstrapStore } from '../../../../server/lib/git/worktree-bootstrap-storage.js';
import {
  createWorktree,
  getWorktreeBootstrapStatus
} from '../../../../server/lib/git/service.js';
const { createTempDir, runGit, canRunGit } = registerGitServiceTestSupport({ afterEach, beforeAll, afterAll });


const readBranchConfig = (cwd, branch, key) => {
  try { return runGit(cwd, ['config', '--get', `branch.${branch}.${key}`]).trim(); } catch { return ''; }
};

describe('createWorktree', () => {
  // A directory this server never bootstrapped is not being populated. Reading
  // it as failed refused every ordinary repository once the OpenCode proxy
  // started gating on this status.
  it('reads a directory with no bootstrap record as ready', async () => {
    const directory = path.join(createTempDir(), 'missing-worktree');

    await expect(getWorktreeBootstrapStatus(directory)).resolves.toMatchObject({
      status: 'ready',
      phase: 'setup-ready',
    });
  });


  it('still inspects a record left pending with no live bootstrap into a repair blocker', async () => {
    const directory = path.join(createTempDir(), 'crashed-worktree');
    const bootstrapStore = {
      read: vi.fn(async () => ({ status: 'pending', phase: 'directory-created', error: null, updatedAt: 1 })),
      write: vi.fn(async (_directory, state) => state),
    };

    await expect(getWorktreeBootstrapStatus(directory, { bootstrapStore })).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'UNKNOWN',
      error: expect.stringContaining('repair'),
    });
    expect(bootstrapStore.write).toHaveBeenCalledOnce();
  });

  it('fails closed when the bootstrap store cannot be read', async () => {
    const directory = path.join(createTempDir(), 'unreadable-store');
    const bootstrapStore = {
      read: vi.fn(async () => { throw new Error('store unreadable'); }),
      write: vi.fn(),
    };

    await expect(getWorktreeBootstrapStatus(directory, { bootstrapStore })).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'UNKNOWN',
    });
  });

  it('reports directory, Git, and setup bootstrap phases while preserving legacy status', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    const setupMarker = path.join(dataHome, 'setup-started');
    const setupScript = path.join(dataHome, 'setup-phase.cjs');
    process.env.XDG_DATA_HOME = dataHome;

    fs.writeFileSync(
      setupScript,
      `require('node:fs').writeFileSync(${JSON.stringify(setupMarker)}, 'started'); setTimeout(() => {}, 1000);\n`,
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
        branchName: 'feature/bootstrap-phases',
        worktreeName: 'bootstrap-phases',
        returnAfterDirectoryCreated: true,
        startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(setupScript)}`,
      });

      expect(created.bootstrapStatus).toMatchObject({
        status: 'pending',
        phase: 'directory-created',
        error: null,
      });

      await expect.poll(() => fs.existsSync(setupMarker), { timeout: 5_000 }).toBe(true);
      await expect(getWorktreeBootstrapStatus(created.path)).resolves.toMatchObject({
        status: 'pending',
        phase: 'git-ready',
        error: null,
      });

      await expect.poll(
        async () => (await getWorktreeBootstrapStatus(created.path)).phase,
        { timeout: 5_000 },
      ).toBe('setup-ready');
      await expect(getWorktreeBootstrapStatus(created.path)).resolves.toMatchObject({
        status: 'ready',
        phase: 'setup-ready',
        error: null,
      });
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('does not report Git-ready when checkout hydration is incomplete', async () => {
    if (!canRunGit()) return;
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    const hydration = {
      status: 'authorization-required',
      submodules: [{
        path: 'vendor/private', status: 'authorization-required',
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Explicit grant required' },
      }],
      lfs: [{ path: '.', status: 'not-needed' }],
    };
    const hydrateCheckout = vi.fn(async () => hydration);
    const bootstrapStore = createWorktreeBootstrapStore({
      filePath: path.join(createTempDir(), 'bootstrap.json'),
    });
    const created = await createWorktree(repo, {
      mode: 'new', branchName: 'feature/hydration-failure', worktreeName: 'hydration-failure',
      returnAfterDirectoryCreated: true,
    }, { hydrateCheckout, bootstrapStore });

    await expect.poll(
      async () => (await getWorktreeBootstrapStatus(created.path, { bootstrapStore })).status,
      { timeout: 5_000 },
    ).toBe('failed');
    const expectedFailure = {
      status: 'failed',
      phase: 'directory-created',
      errorCode: 'AUTHENTICATION_REQUIRED',
      hydration: {
        status: 'authorization-required',
        submodules: [{
          path: 'vendor/private',
          status: 'authorization-required',
          error: { code: 'AUTHENTICATION_REQUIRED' },
        }],
        lfs: [{ path: '.', status: 'not-needed' }],
      },
    };
    await expect(getWorktreeBootstrapStatus(created.path, { bootstrapStore })).resolves.toMatchObject(expectedFailure);
    await expect(bootstrapStore.read(created.path)).resolves.toMatchObject(expectedFailure);
    expect(hydrateCheckout).toHaveBeenCalledWith({ directory: created.path, parentRemoteName: '' });
  });

  it('hydrates a checkout made from a local branch through the branch\'s own remote', async () => {
    if (!canRunGit()) return;
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    runGit(repo, ['remote', 'add', 'upstream', 'https://example.com/team/repo.git']);
    runGit(repo, ['remote', 'add', 'origin', 'https://example.com/me/repo.git']);
    runGit(repo, ['config', 'branch.main.remote', 'upstream']);
    const hydrateCheckout = vi.fn(async () => ({ status: 'not-needed', submodules: [], lfs: [] }));
    const bootstrapStore = createWorktreeBootstrapStore({ filePath: path.join(createTempDir(), 'bootstrap.json') });
    const created = await createWorktree(repo, {
      mode: 'new', branchName: 'feature/from-local', worktreeName: 'from-local', startRef: 'main',
      returnAfterDirectoryCreated: true,
    }, { hydrateCheckout, bootstrapStore });
    await expect.poll(
      async () => (await getWorktreeBootstrapStatus(created.path, { bootstrapStore })).status,
      { timeout: 5_000 },
    ).not.toBe('pending');
    // The branch's upstream, not the first remote in the list.
    expect(hydrateCheckout).toHaveBeenCalledWith({ directory: created.path, parentRemoteName: 'upstream' });
  });

  const installPostCheckoutHook = (repo, script, executable = true) => {
    const hookPath = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hookPath, script);
    if (executable) {
      fs.chmodSync(hookPath, 0o755);
    }
    return hookPath;
  };

  it('does not run the post-checkout hook while populating a created worktree', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);
      const hookLog = path.join(dataHome, 'post-checkout.log');
      installPostCheckoutHook(
        repo,
        `#!/bin/sh\nprintf '%s|%s|%s|%s' "$1" "$2" "$3" "$(pwd -P)" > ${JSON.stringify(hookLog)}\n`,
      );

      const created = await createWorktree(repo, {
        mode: 'new',
        worktreeName: 'hook-test',
        branchName: 'openchamber/hook-test',
        returnAfterDirectoryCreated: true,
      });

      await expect.poll(
        async () => (await getWorktreeBootstrapStatus(created.path)).status,
        { timeout: 5_000 },
      ).toBe('ready');
      expect(fs.existsSync(hookLog)).toBe(false);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('skips a non-executable post-checkout hook', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);

      const hookLog = path.join(dataHome, 'post-checkout-skipped.log');
      installPostCheckoutHook(
        repo,
        `#!/bin/sh\nprintf 'ran' > ${JSON.stringify(hookLog)}\n`,
        false,
      );

      const created = await createWorktree(repo, {
        mode: 'new',
        worktreeName: 'hook-skip-test',
        branchName: 'openchamber/hook-skip-test',
        returnAfterDirectoryCreated: true,
      });

      await expect.poll(
        async () => (await getWorktreeBootstrapStatus(created.path)).status,
        { timeout: 5_000 },
      ).toBe('ready');
      expect(fs.existsSync(hookLog)).toBe(false);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('does not execute a failing post-checkout hook during bootstrap', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);

      const hookLog = path.join(dataHome, 'post-checkout-failed.log');
      installPostCheckoutHook(
        repo,
        `#!/bin/sh\nprintf 'ran' > ${JSON.stringify(hookLog)}\nexit 1\n`,
      );

      const created = await createWorktree(repo, {
        mode: 'new',
        worktreeName: 'hook-fail-test',
        branchName: 'openchamber/hook-fail-test',
        returnAfterDirectoryCreated: true,
      });

      await expect.poll(
        async () => (await getWorktreeBootstrapStatus(created.path)).status,
        { timeout: 5_000 },
      ).toBe('ready');
      expect(fs.existsSync(hookLog)).toBe(false);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

});
