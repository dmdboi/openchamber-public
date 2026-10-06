import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi, beforeAll } from 'vitest';
import { registerGitServiceTestSupport } from './service-test-support.js';
import {
  createWorktree,
  getWorktreeBootstrapStatus,
  getBranches,
  validateWorktreeCreate,
  removeRemote
} from '../../../../server/lib/git/service.js';
const { createTempDir, runGit, createRepositoryWithRemote, canRunGit } = registerGitServiceTestSupport({ afterEach, beforeAll, afterAll });


describe('git remote arguments with option-like names', () => {
  const OPTION_LIKE_REMOTE = '--mirror';

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

  const addOptionLikeRemote = (repository, remoteUrl, { fetch = true } = {}) => {
    runGit(repository, ['remote', 'add', '--', OPTION_LIKE_REMOTE, remoteUrl]);
    if (fetch) {
      runGit(repository, ['fetch', '--', OPTION_LIKE_REMOTE]);
    }
  };

  it('creates a worktree with a remote whose name looks like an option', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { remote, repository } = createRepositoryWithRemote();

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'openchamber/option-like-remote',
        worktreeName: 'option-like-remote',
        ensureRemoteName: OPTION_LIKE_REMOTE,
        ensureRemoteUrl: remote,
      });

      expect(created.branch).toBe('openchamber/option-like-remote');
      expect(runGit(repository, ['remote', 'get-url', '--', OPTION_LIKE_REMOTE]).trim()).toBe(remote);
    });
  }, 30_000);

  it('removes an option-like remote', async () => {
    if (!canRunGit()) return;

    const { remote, repository } = createRepositoryWithRemote();
    addOptionLikeRemote(repository, remote, { fetch: false });

    await removeRemote(repository, { remote: OPTION_LIKE_REMOTE });

    expect(runGit(repository, ['remote']).split('\n').map((line) => line.trim())).not.toContain(OPTION_LIKE_REMOTE);
  }, 30_000);

  it('validates a start ref and upstream on an option-like remote', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { remote, repository } = createRepositoryWithRemote();
      fs.writeFileSync(path.join(repository, 'OPTION.md'), '# option\n');
      runGit(repository, ['add', 'OPTION.md']);
      runGit(repository, ['commit', '-m', 'option-like branch']);
      runGit(repository, ['push', '--', remote, 'HEAD:refs/heads/feature/option-like']);
      addOptionLikeRemote(repository, remote);

      const validation = await validateWorktreeCreate(repository, {
        mode: 'new',
        branchName: 'feature/option-like-worktree',
        worktreeName: 'option-like-worktree',
        startRef: `remotes/${OPTION_LIKE_REMOTE}/feature/option-like`,
        setUpstream: true,
        upstreamRemote: OPTION_LIKE_REMOTE,
        upstreamBranch: 'feature/option-like',
      });

      expect(validation.errors).toEqual([]);
      expect(validation.ok).toBe(true);
    });
  }, 30_000);

  it('creates a worktree from an option-like remote start ref', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { remote, repository } = createRepositoryWithRemote();
      fs.writeFileSync(path.join(repository, 'OPTION.md'), '# option\n');
      runGit(repository, ['add', 'OPTION.md']);
      runGit(repository, ['commit', '-m', 'option-like start ref']);
      const sha = runGit(repository, ['rev-parse', 'HEAD']).trim();
      runGit(repository, ['push', '--', remote, 'HEAD:refs/heads/feature/option-like']);
      addOptionLikeRemote(repository, remote, { fetch: false });

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'openchamber/option-like-start-ref',
        worktreeName: 'option-like-start-ref',
        startRef: `remotes/${OPTION_LIKE_REMOTE}/feature/option-like`,
      });

      expect(created.branch).toBe('openchamber/option-like-start-ref');
      expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(sha);
      await expect.poll(
        () => getWorktreeBootstrapStatus(created.path).then((status) => status.status === 'ready' || status.status === 'failed'),
        { timeout: 5_000 }
      ).toBe(true);
    });
  }, 30_000);

  it('lists branches without treating an option-like remote as an option', async () => {
    if (!canRunGit()) return;

    const { remote, repository } = createRepositoryWithRemote();
    addOptionLikeRemote(repository, remote);
    const head = runGit(repository, ['rev-parse', 'HEAD']).trim();
    runGit(repository, ['update-ref', `refs/remotes/${OPTION_LIKE_REMOTE}/gone`, head]);
    runGit(repository, ['symbolic-ref', `refs/remotes/${OPTION_LIKE_REMOTE}/HEAD`, `refs/remotes/${OPTION_LIKE_REMOTE}/react`]);

    const branches = await getBranches(repository);

    expect(branches.all).toContain(`remotes/${OPTION_LIKE_REMOTE}/react`);
    expect(branches.all).not.toContain(`remotes/${OPTION_LIKE_REMOTE}/gone`);
    expect(branches.defaultBranches[OPTION_LIKE_REMOTE]).toBe('react');
  }, 30_000);

  it('does not interpret an option-like ensureRemoteUrl as a git option when validating', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const markerPath = path.join(createTempDir(), 'upload-pack-ran.marker');
      const scriptPath = path.join(createTempDir(), 'upload-pack-probe.sh');
      fs.writeFileSync(scriptPath, `#!/bin/sh\ntouch ${JSON.stringify(markerPath)}\nexit 1\n`);
      fs.chmodSync(scriptPath, 0o755);

      const validation = await validateWorktreeCreate(repository, {
        mode: 'existing',
        branchName: 'feature/login-wt',
        worktreeName: 'feature-login-wt',
        existingBranch: 'remotes/pr-alice/feature/login',
        ensureRemoteName: 'pr-alice',
        ensureRemoteUrl: `--upload-pack=${scriptPath}`,
      });

      expect(fs.existsSync(markerPath)).toBe(false);
      expect(validation.ok).toBe(false);
    });
  }, 30_000);
});
