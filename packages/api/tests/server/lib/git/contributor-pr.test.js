import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi, beforeAll } from 'vitest';
import { registerGitServiceTestSupport } from './service-test-support.js';
import {
  createWorktree,
  getWorktreeBootstrapStatus,
  validateWorktreeCreate
} from '../../../../server/lib/git/service.js';
const { createTempDir, runGit, createRepositoryWithRemote, canRunGit } = registerGitServiceTestSupport({ afterEach, beforeAll, afterAll });


describe('createWorktree from a forked GitHub PR', () => {
  const withDataHome = async (test) => {
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;
    try {
      await test(dataHome);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  };

  const publishForkHead = (repository, forkBare, branchName) => {
    fs.writeFileSync(path.join(repository, 'FORK.md'), `# ${branchName}\n`);
    runGit(repository, ['add', 'FORK.md']);
    runGit(repository, ['commit', '-m', `fork ${branchName}`]);
    const sha = runGit(repository, ['rev-parse', 'HEAD']).trim();
    runGit(repository, ['push', forkBare, `HEAD:refs/heads/${branchName}`]);
    return sha;
  };

  const getBranchTrackingRemote = (directory, branch) => {
    try {
      return runGit(directory, ['config', '--get', `branch.${branch}.remote`]).trim();
    } catch {
      return '';
    }
  };

  const getRemoteUrlOrNull = (directory, remote) => {
    try {
      return runGit(directory, ['remote', 'get-url', remote]).trim();
    } catch {
      return null;
    }
  };

  const forkWorktreeInput = ({ fork, worktreeName }) => ({
    mode: 'existing',
    branchName: 'feature/login',
    worktreeName,
    existingBranch: 'remotes/pr-alice/feature/login',
    setUpstream: true,
    upstreamRemote: 'pr-alice',
    upstreamBranch: 'feature/login',
    ensureRemoteName: 'pr-alice',
    ensureRemoteUrl: fork,
  });

  it('rejects direct contributor creation without managed transfer', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const fork = createTempDir();
      runGit(fork, ['init', '--bare']);
      publishForkHead(repository, fork, 'feature/login');

      await expect(createWorktree(repository, {
        ...forkWorktreeInput({ fork, worktreeName: 'pr-42' }),
        contributorFork: true,
      }))
        .rejects.toMatchObject({ code: 'CONTRIBUTOR_MANAGED_TRANSFER_REQUIRED', status: 409 });
      expect(runGit(repository, ['remote'])).not.toContain('pr-alice');
    });
  }, 30_000);

  it('persists contributor provenance before success and skips hooks, setup, and upstream', async () => {
    if (!canRunGit()) return;

    await withDataHome(async (dataHome) => {
      const { repository } = createRepositoryWithRemote();
      const fork = createTempDir();
      runGit(fork, ['init', '--bare']);
      const sha = publishForkHead(repository, fork, 'feature/login');
      runGit(repository, ['update-ref', 'refs/remotes/pr-alice/feature/login', sha]);
      const hookMarker = path.join(dataHome, 'contributor-hook');
      const setupMarker = path.join(dataHome, 'contributor-setup');
      const setupScript = path.join(dataHome, 'contributor-setup.cjs');
      fs.writeFileSync(path.join(repository, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\n: > ${JSON.stringify(hookMarker)}\n`);
      fs.chmodSync(path.join(repository, '.git', 'hooks', 'post-checkout'), 0o755);
      fs.writeFileSync(setupScript, `require('node:fs').writeFileSync(${JSON.stringify(setupMarker)}, 'ran');\n`);
      const compareAndSwap = vi.fn(async (_directory, expectedRevision, provenance) => ({
        worktreeId: 'worktree_one', repositoryId: 'repo_one', revision: expectedRevision + 1, provenance,
      }));

      const created = await createWorktree(repository, {
        ...forkWorktreeInput({ fork, worktreeName: 'pr-42-safe' }),
        contributorTransferComplete: true,
        setUpstream: false,
        contributorFork: true,
        expectedRevision: sha,
        returnAfterDirectoryCreated: true,
        startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(setupScript)}`,
      }, {
        contributorProvenance: { compareAndSwap },
        contributorSource: {
          headRef: 'refs/heads/feature/login', sourceProject: { id: 'alice/app' }, targetProject: { id: 'acme/app' },
          context: { provider: 'github', instance: 'github.com', accountId: 'account_one', bindingRevision: 3, primaryRemote: 'origin' },
        },
      });

      expect(created.provenance).toEqual({
        kind: 'contributor-fork', revision: 1, trust: 'untrusted', push: 'destination-selection-required',
      });
      expect(compareAndSwap).toHaveBeenCalledWith(created.path, 0, {
        kind: 'contributor-fork', remoteName: 'pr-alice',
        endpointFingerprint: expect.any(String), sourceSha: sha,
        sourceRef: 'refs/heads/feature/login', sourceProjectId: 'alice/app', targetProjectId: 'acme/app',
        provider: 'github', instance: 'github.com', accountId: 'account_one', bindingRevision: 3,
        primaryRemote: 'origin', projectId: expect.any(String), setupCommand: expect.any(String),
      });
      await expect.poll(() => getWorktreeBootstrapStatus(created.path).then((status) => status.status), {
        timeout: 5_000,
      }).toBe('ready');
      expect(getBranchTrackingRemote(created.path, 'feature/login')).toBe('');
      expect(fs.existsSync(hookMarker)).toBe(false);
      expect(fs.existsSync(setupMarker)).toBe(false);
    });
  }, 30_000);

  it('does not report contributor creation when provenance persistence fails', async () => {
    if (!canRunGit()) return;
    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const fork = createTempDir();
      runGit(fork, ['init', '--bare']);
      const sha = publishForkHead(repository, fork, 'feature/login');
      runGit(repository, ['update-ref', 'refs/remotes/pr-alice/feature/login', sha]);
      await expect(createWorktree(repository, {
        ...forkWorktreeInput({ fork, worktreeName: 'pr-42-provenance-failure' }),
        contributorTransferComplete: true,
        setUpstream: false,
        contributorFork: true,
        expectedRevision: sha,
      }, {
        contributorProvenance: { compareAndSwap: async () => { throw new Error('provenance write failed'); } },
        contributorSource: {
          headRef: 'refs/heads/feature/login', sourceProject: { id: 'alice/app' }, targetProject: { id: 'acme/app' },
          context: { provider: 'github', instance: 'github.com', accountId: 'account_one', bindingRevision: 3, primaryRemote: 'origin' },
        },
      })).rejects.toThrow('provenance write failed');
      expect(runGit(repository, ['worktree', 'list', '--porcelain'])).not.toContain('pr-42-provenance-failure');
    });
  }, 30_000);

  it('fails closed before transferring a contributor head with ambient credentials', async () => {
    if (!canRunGit()) return;
    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const fork = createTempDir();
      runGit(fork, ['init', '--bare']);
      const sha = publishForkHead(repository, fork, 'feature/login');
      await expect(createWorktree(repository, {
        ...forkWorktreeInput({ fork, worktreeName: 'pr-42-managed-transfer-required' }),
        contributorFork: true,
        expectedRevision: sha,
      }, { contributorProvenance: { compareAndSwap: vi.fn() } })).rejects.toMatchObject({
        code: 'CONTRIBUTOR_MANAGED_TRANSFER_REQUIRED', status: 409,
      });
      expect(getRemoteUrlOrNull(repository, 'pr-alice')).toBeNull();
    });
  }, 30_000);

  it('requires an explicit contributor transfer before worktree creation', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const missingFork = path.join(createTempDir(), 'missing-fork.git');
      const before = runGit(repository, ['worktree', 'list', '--porcelain']);

      await expect(createWorktree(repository, forkWorktreeInput({
        fork: missingFork,
        worktreeName: 'pr-42-unreachable',
      }))).rejects.toThrow(/not available locally/i);

      expect(runGit(repository, ['worktree', 'list', '--porcelain'])).toBe(before);
      expect(getRemoteUrlOrNull(repository, 'pr-alice')).toBeNull();

      const validation = await validateWorktreeCreate(repository, forkWorktreeInput({
        fork: missingFork,
        worktreeName: 'pr-42-unreachable',
      }));
      expect(validation.ok).toBe(false);
      expect(validation.errors.some((error) => /not available locally/i.test(error.message))).toBe(true);
    });
  }, 30_000);

  it('never overwrites an existing remote with a different contributor endpoint', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const originalFork = createTempDir();
      runGit(originalFork, ['init', '--bare']);
      runGit(repository, ['remote', 'add', 'pr-alice', originalFork]);
      const missingFork = path.join(createTempDir(), 'missing-fork.git');
      const marker = path.join(createTempDir(), 'set-url-used');
      const previousPath = process.env.PATH;
      const previousRealGit = process.env.REAL_GIT;
      const previousMarker = process.env.SET_URL_MARKER;
      if (process.platform !== 'win32') {
        const wrapperDirectory = createTempDir();
        const wrapper = path.join(wrapperDirectory, 'git');
        const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
        fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = "remote" ] && [ "$2" = "set-url" ]; then : > "$SET_URL_MARKER"; fi
exec "$REAL_GIT" "$@"
`);
        fs.chmodSync(wrapper, 0o755);
        process.env.PATH = `${wrapperDirectory}${path.delimiter}${previousPath || ''}`;
        process.env.REAL_GIT = realGit;
        process.env.SET_URL_MARKER = marker;
      }

      try {
        await expect(createWorktree(repository, forkWorktreeInput({
          fork: missingFork,
          worktreeName: 'pr-42-restore-remote',
        }))).rejects.toMatchObject({ code: 'CONTRIBUTOR_REMOTE_COLLISION', status: 409 });

        expect(getRemoteUrlOrNull(repository, 'pr-alice')).toBe(originalFork);
        expect(fs.existsSync(marker)).toBe(false);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousRealGit === undefined) delete process.env.REAL_GIT;
        else process.env.REAL_GIT = previousRealGit;
        if (previousMarker === undefined) delete process.env.SET_URL_MARKER;
        else process.env.SET_URL_MARKER = previousMarker;
      }
    });
  }, 30_000);

  it('defers a same-repository change request branch to its transfer instead of reporting it missing', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const input = { ...forkWorktreeInput({ fork: repository, worktreeName: 'mr-7' }), changeRequestTransfer: true };

      // The head is not fetched yet; only the pending transfer is reported.
      const validation = await validateWorktreeCreate(repository, input);
      expect(validation.errors.map((error) => error.code)).toEqual(['contributor_transfer_unavailable']);
    });
  }, 30_000);

  it('rejects a fork branch that moved away from the requested PR head revision', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const fork = createTempDir();
      runGit(fork, ['init', '--bare']);
      const actualRevision = publishForkHead(repository, fork, 'feature/login');
      runGit(repository, ['update-ref', 'refs/remotes/pr-alice/feature/login', actualRevision]);
      const input = {
        ...forkWorktreeInput({ fork, worktreeName: 'pr-42-stale' }),
        expectedRevision: '1111111111111111111111111111111111111111',
      };

      const validation = await validateWorktreeCreate(repository, input);
      expect(validation.ok).toBe(false);
      expect(validation.errors.some((error) => /revision does not match/i.test(error.message))).toBe(true);
      await expect(createWorktree(repository, input)).rejects.toThrow(/revision does not match/i);
    });
  }, 30_000);

  it('creates from the verified revision when the remote-tracking ref moves before worktree add', async () => {
    if (!canRunGit() || process.platform === 'win32') return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const fork = createTempDir();
      runGit(fork, ['init', '--bare']);
      const expectedRevision = publishForkHead(repository, fork, 'feature/login');
      runGit(repository, ['update-ref', 'refs/remotes/pr-alice/feature/login', expectedRevision]);

      fs.writeFileSync(path.join(repository, 'FORK.md'), '# moved\n');
      runGit(repository, ['add', 'FORK.md']);
      runGit(repository, ['commit', '-m', 'move tracking ref during worktree creation']);
      const movedRevision = runGit(repository, ['rev-parse', 'HEAD']).trim();

      const wrapperDirectory = createTempDir();
      const marker = path.join(wrapperDirectory, 'moved');
      const wrapper = path.join(wrapperDirectory, 'git');
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = "worktree" ] && [ "$2" = "add" ] && [ ! -e "$RACE_MARKER" ]; then
  : > "$RACE_MARKER"
  "$REAL_GIT" -C "$RACE_REPOSITORY" update-ref "$RACE_REF" "$RACE_REVISION" || exit $?
fi
exec "$REAL_GIT" "$@"
`);
      fs.chmodSync(wrapper, 0o755);

      const previousEnvironment = {
        PATH: process.env.PATH,
        REAL_GIT: process.env.REAL_GIT,
        RACE_MARKER: process.env.RACE_MARKER,
        RACE_REPOSITORY: process.env.RACE_REPOSITORY,
        RACE_REF: process.env.RACE_REF,
        RACE_REVISION: process.env.RACE_REVISION,
      };
      Object.assign(process.env, {
        PATH: `${wrapperDirectory}${path.delimiter}${process.env.PATH || ''}`,
        REAL_GIT: realGit,
        RACE_MARKER: marker,
        RACE_REPOSITORY: repository,
        RACE_REF: 'refs/remotes/pr-alice/feature/login',
        RACE_REVISION: movedRevision,
      });

      try {
        const created = await createWorktree(repository, {
          ...forkWorktreeInput({ fork, worktreeName: 'pr-42-race' }),
          expectedRevision,
        });

        expect(fs.existsSync(marker)).toBe(true);
        expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(expectedRevision);
        expect(created.branch).toBe('feature/login');
      } finally {
        for (const [key, value] of Object.entries(previousEnvironment)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  }, 30_000);

  it('does not write upstream tracking when the upstream ref cannot be fetched', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      runGit(repository, ['branch', 'feature/tracking']);
      const emptyRemote = createTempDir();
      runGit(emptyRemote, ['init', '--bare']);
      runGit(repository, ['remote', 'add', 'broken-upstream', emptyRemote]);

      const created = await createWorktree(repository, {
        mode: 'existing',
        branchName: 'feature/tracking-wt',
        worktreeName: 'feature-tracking-wt',
        existingBranch: 'feature/tracking',
        setUpstream: true,
        upstreamRemote: 'broken-upstream',
        upstreamBranch: 'does-not-exist',
      });

      await expect.poll(
        () => getWorktreeBootstrapStatus(created.path).then((status) => status.status === 'ready' || status.status === 'failed'),
        { timeout: 5_000 }
      ).toBe(true);

      expect(getBranchTrackingRemote(created.path, 'feature/tracking-wt')).toBe('');
    });
  }, 30_000);
});
