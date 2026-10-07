import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, afterEach, beforeAll, afterAll } from 'vitest';
import { registerGitServiceTestSupport } from './service-test-support.js';
import {
  checkoutBranch,
  commit,
  getStatus,
  resolveBaseRefForLog
} from '../../../../server/lib/git/service.js';
const { createTempDir, runGit, canRunGit } = registerGitServiceTestSupport({ afterEach, beforeAll, afterAll });


// ---------------------------------------------------------------------------
// resolveBaseRefForLog
// ---------------------------------------------------------------------------

describe('git environment through simple-git', () => {
  const withProcessEnv = async (overrides, run) => {
    const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return await run();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  /** A repository whose pre-commit hook writes the named variables to a log. */
  const createRepositoryLoggingHookEnv = (names) => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    const hookLog = path.join(createTempDir(), 'pre-commit-env.log');
    const hookPath = path.join(repo, '.git', 'hooks', 'pre-commit');
    const fields = names.map((name) => `\${${name}-<unset>}`).join('|');
    fs.writeFileSync(hookPath, `#!/bin/sh\nprintf '%s' "${fields}" > ${JSON.stringify(hookLog)}\n`);
    fs.chmodSync(hookPath, 0o755);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    return { repo, readHookLog: () => fs.readFileSync(hookLog, 'utf8') };
  };

  it('runs git with the environment OpenChamber builds, not the raw process env', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    await withProcessEnv({
      GIT_TERMINAL_PROMPT: undefined,
      APPDIR: '/tmp/.mount_OpenChAbC123',
      LD_LIBRARY_PATH: '/tmp/.mount_OpenChAbC123/usr/lib:/opt/x:',
    }, async () => {
      const { repo, readHookLog } = createRepositoryLoggingHookEnv(['GIT_TERMINAL_PROMPT', 'LD_LIBRARY_PATH']);
      await commit(repo, 'init', { addAll: true });
      expect(readHookLog()).toBe('0|/opt/x');
    });
  });

  it('keeps working, and passes them to git, when the process env sets editor, pager, ssh or askpass programs', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const programs = {
      EDITOR: 'vim',
      GIT_EDITOR: 'vim',
      PAGER: 'less',
      GIT_PAGER: 'less',
      GIT_SSH_COMMAND: 'ssh -i /tmp/openchamber-test-key -o IdentitiesOnly=yes',
      GIT_ASKPASS: '/usr/bin/true',
      SSH_ASKPASS: '/usr/bin/true',
    };
    // Git itself hands hooks GIT_EDITOR=: when a commit message needs no editor.
    const observed = Object.keys(programs).filter((name) => name !== 'GIT_EDITOR');
    await withProcessEnv(programs, async () => {
      const { repo, readHookLog } = createRepositoryLoggingHookEnv(observed);
      await commit(repo, 'init', { addAll: true });
      expect(readHookLog()).toBe(observed.map((name) => programs[name]).join('|'));
      const status = await getStatus(repo);
      expect(status.current).toBe('main');
    });
  });
});

describe('git environment inside an AppImage', () => {
  // Worktree population never runs hooks (an untrusted checkout must not run
  // code), so a branch switch is where a post-checkout hook runs.
  it('runs a post-checkout hook without the AppImage launcher library path', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const previous = {
      APPDIR: process.env.APPDIR,
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
    };
    process.env.APPDIR = '/tmp/.mount_OpenChAbC123';
    process.env.LD_LIBRARY_PATH = '/tmp/.mount_OpenChAbC123/usr/lib:/opt/x:';

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);
      runGit(repo, ['branch', 'other']);
      const hookLog = path.join(createTempDir(), 'post-checkout-env.log');
      const hookPath = path.join(repo, '.git', 'hooks', 'post-checkout');
      fs.writeFileSync(hookPath, `#!/bin/sh\nprintf '%s' "\${LD_LIBRARY_PATH-<unset>}" > ${JSON.stringify(hookLog)}\n`);
      fs.chmodSync(hookPath, 0o755);

      await checkoutBranch(repo, 'other');

      expect(fs.readFileSync(hookLog, 'utf8')).toBe('/opt/x');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
