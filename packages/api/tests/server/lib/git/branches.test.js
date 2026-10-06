import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { registerGitServiceTestSupport } from './service-test-support.js';
import { checkoutBranch, commit, getBranches, parseRemoteListing, parseBranchCreationSource, rebase } from '../../../../server/lib/git/service.js';
const { createTempDir, runGit, createRepositoryWithRemote, canRunGit, createTempRepo } = registerGitServiceTestSupport({ afterEach, beforeAll, afterAll });

describe('checkoutBranch', () => {
  it('checks out a local branch by name', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['branch', 'feature']);

    const result = await checkoutBranch(repository, 'feature');

    expect(result).toEqual({ success: true, branch: 'feature' });
    expect(runGit(repository, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature');
  });

  it('creates a tracking local branch instead of detaching HEAD on a remote branch', async () => {
    const { repository } = createRepositoryWithRemote({ defaultBranch: 'react' });

    const result = await checkoutBranch(repository, 'origin/react');

    expect(result).toEqual({ success: true, branch: 'react' });
    expect(runGit(repository, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('react');
    expect(runGit(repository, ['rev-parse', '--abbrev-ref', 'react@{upstream}']).trim()).toBe('origin/react');
  });

  it('checks out the existing local branch when a remote branch is picked', async () => {
    const { repository } = createRepositoryWithRemote({ defaultBranch: 'react' });
    runGit(repository, ['branch', 'react', 'origin/react']);

    const result = await checkoutBranch(repository, 'origin/react');

    expect(result).toEqual({ success: true, branch: 'react' });
    expect(runGit(repository, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('react');
  });

  it('accepts the remotes/ prefixed form of a remote branch', async () => {
    const { repository } = createRepositoryWithRemote({ defaultBranch: 'react' });

    const result = await checkoutBranch(repository, 'remotes/origin/react');

    expect(result).toEqual({ success: true, branch: 'react' });
    expect(runGit(repository, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('react');
  });

  it('prefers a local branch whose name looks like a remote ref', async () => {
    const { repository } = createRepositoryWithRemote({ defaultBranch: 'react' });
    runGit(repository, ['branch', 'origin/react']);

    const result = await checkoutBranch(repository, 'origin/react');

    expect(result).toEqual({ success: true, branch: 'origin/react' });
    expect(runGit(repository, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/origin/react');
  });

  it('rejects an unknown branch', async () => {
    const { repository } = createRepositoryWithRemote();
    await expect(checkoutBranch(repository, 'does-not-exist')).rejects.toThrow();
  });

  it('fetches a remote-only branch that was never fetched locally (#2735)', async () => {
    const { repository, remote } = createRepositoryWithRemote({ defaultBranch: 'react' });
    // A collaborator pushes straight to the remote; this repository never
    // fetches, so `remotes/origin/collab` is listed (#2098) with no local ref.
    const collaborator = createTempDir();
    runGit(collaborator, ['clone', remote, '.']);
    runGit(collaborator, ['config', 'user.email', 'test@example.com']);
    runGit(collaborator, ['config', 'user.name', 'Test']);
    runGit(collaborator, ['checkout', '-b', 'collab']);
    runGit(collaborator, ['push', 'origin', 'collab']);

    const result = await checkoutBranch(repository, 'remotes/origin/collab');

    expect(result).toEqual({ success: true, branch: 'collab' });
    expect(runGit(repository, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('collab');
    expect(runGit(repository, ['rev-parse', '--abbrev-ref', 'collab@{upstream}']).trim()).toBe('origin/collab');
  });

  it('reports a clear failure when the remote branch no longer exists', async () => {
    const { repository } = createRepositoryWithRemote({ defaultBranch: 'react' });

    await expect(checkoutBranch(repository, 'remotes/origin/never-pushed')).rejects.toThrow(
      /Failed to fetch never-pushed from origin/
    );
  });
});

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

describe.runIf(canRunGit())('getBranches', () => {
  it('returns a remote default branch whose name is not a conventional fallback', async () => {
    const { repository } = createRepositoryWithRemote({ remoteName: 'origin', defaultBranch: 'react' });

    await expect(getBranches(repository)).resolves.toMatchObject({
      defaultBranches: { origin: 'react' },
    });
  });

  it('does not infer a default branch when no local remote/HEAD exists', async () => {
    const { repository } = createRepositoryWithRemote({ remoteName: 'origin', defaultBranch: 'react' });
    runGit(repository, ['remote', 'set-head', 'origin', '--delete']);

    await expect(getBranches(repository)).resolves.toMatchObject({
      defaultBranches: {},
    });
  });

  it('keeps the branches of a remote that cannot be reached', async () => {
    const { repository, remote } = createRepositoryWithRemote({ remoteName: 'origin', defaultBranch: 'react' });
    fs.rmSync(remote, { recursive: true, force: true });

    const branches = await getBranches(repository);

    expect(branches.all).toContain('remotes/origin/react');
  });

  it('includes remote branches with no local tracking ref and prunes refs deleted on the remote (#2098)', async () => {
    const remote = createTempDir();
    runGit(remote, ['init', '--bare', '--initial-branch=main']);

    const repository = createTempDir();
    runGit(repository, ['init', '-b', 'main']);
    runGit(repository, ['config', 'user.email', 'test@example.com']);
    runGit(repository, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n');
    runGit(repository, ['add', 'README.md']);
    runGit(repository, ['commit', '-m', 'init']);
    runGit(repository, ['remote', 'add', 'origin', remote]);
    runGit(repository, ['push', '-u', 'origin', 'main']);
    runGit(repository, ['checkout', '-b', 'feature-known']);
    runGit(repository, ['push', '-u', 'origin', 'feature-known']);
    // This tracking ref will go stale: the collaborator deletes the branch on
    // the remote below, and the list must prune it.
    runGit(repository, ['checkout', '-b', 'feature-stale']);
    runGit(repository, ['push', '-u', 'origin', 'feature-stale']);
    runGit(repository, ['checkout', 'main']);
    runGit(repository, ['branch', '-D', 'feature-stale']);

    // A collaborator pushes a branch straight to the remote and deletes
    // another; this repository never fetches, so it has no local
    // remote-tracking ref for feature-remote-only.
    const collaborator = createTempDir();
    runGit(collaborator, ['clone', remote, '.']);
    runGit(collaborator, ['config', 'user.email', 'test@example.com']);
    runGit(collaborator, ['config', 'user.name', 'Test']);
    runGit(collaborator, ['checkout', '-b', 'feature-remote-only']);
    runGit(collaborator, ['push', 'origin', 'feature-remote-only']);
    runGit(collaborator, ['push', 'origin', ':feature-stale']);

    const branches = await getBranches(repository);

    expect(branches.all).toContain('remotes/origin/feature-remote-only');
    expect(branches.all).toContain('remotes/origin/feature-known');
    expect(branches.all).toContain('feature-known');
    expect(branches.all).not.toContain('remotes/origin/feature-stale');
  });

  it('answers from local refs without asking any remote when asked for local', async () => {
    const { repository, remote } = createRepositoryWithRemote({ remoteName: 'origin', defaultBranch: 'react' });
    const collaborator = createTempDir();
    runGit(collaborator, ['clone', remote, '.']);
    runGit(collaborator, ['checkout', '-b', 'remote-only']);
    runGit(collaborator, ['push', 'origin', 'remote-only']);

    const branches = await getBranches(repository, { remote: 'local' });

    // Only what `git branch -a` knows: a branch nobody fetched is not listed.
    expect(branches.all).toContain('remotes/origin/react');
    expect(branches.all).not.toContain('remotes/origin/remote-only');
  });

  it('reuses a remote\'s answer until its local tracking refs change', async () => {
    const { repository, remote } = createRepositoryWithRemote({ remoteName: 'origin', defaultBranch: 'react' });
    expect((await getBranches(repository)).all).not.toContain('remotes/origin/later');
    const collaborator = createTempDir();
    runGit(collaborator, ['clone', remote, '.']);
    runGit(collaborator, ['checkout', '-b', 'later']);
    runGit(collaborator, ['push', 'origin', 'later']);

    // Within the freshness window the remote is not asked again.
    expect((await getBranches(repository)).all).not.toContain('remotes/origin/later');
    // A fetch here changes the tracking refs, so the remote is read again.
    runGit(repository, ['fetch', 'origin']);
    expect((await getBranches(repository)).all).toContain('remotes/origin/later');
  });
});

describe('parseRemoteListing', () => {
  it('reads CRLF output as Git for Windows may print it', () => {
    const listing = [
      'origin\tgit@github.com:owner/repo.git (fetch)',
      'origin\tgit@github.com:owner/push.git (push)',
      'mirror\thttps://example.com/a b.git (fetch)',
      'mirror\thttps://example.com/a b.git (push)',
      'bare\t',
      '',
    ].join('\r\n');
    expect(parseRemoteListing(['bare', 'mirror', 'origin'], listing)).toEqual([
      { name: 'bare', fetchUrl: 'bare', pushUrl: 'bare' },
      { name: 'mirror', fetchUrl: 'https://example.com/a b.git', pushUrl: 'https://example.com/a b.git' },
      { name: 'origin', fetchUrl: 'git@github.com:owner/repo.git', pushUrl: 'git@github.com:owner/push.git' },
    ]);
  });
});

describe('parseBranchCreationSource', () => {
  it('does not reuse the creation base after a rebase', () => {
    expect(parseBranchCreationSource('rebase (finish): refs/heads/feature onto abc123\nbranch: Created from main')).toBeNull();
  });
  it('returns the source ref from the oldest creation entry', () => {
    // Reflog lists newest entries first; creation is the last line.
    const reflog = [
      'commit: abc123',
      'branch: Created from origin/main',
    ].join('\n');
    expect(parseBranchCreationSource(reflog)).toBe('origin/main');
  });

  it('returns null when the branch was created from a detached HEAD pointer', () => {
    const reflog = 'branch: Created from HEAD@{0}';
    expect(parseBranchCreationSource(reflog)).toBeNull();
  });

  it('returns null when the branch was created from the current HEAD without a named source', () => {
    // `git switch -c <branch>` / `git checkout -b <branch>` from the current
    // branch record `branch: Created from HEAD` in the reflog (git 2.x). The
    // source branch name is not recorded, so no base can be derived from it.
    const reflog = 'branch: Created from HEAD';
    expect(parseBranchCreationSource(reflog)).toBeNull();
  });

  it('returns null when the branch was created from a raw commit', () => {
    const reflog = 'branch: Created from 9a3b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b';
    expect(parseBranchCreationSource(reflog)).toBeNull();
  });

  it('returns null when there is no creation entry', () => {
    const reflog = ['commit: abc123', 'reset: moving to HEAD'].join('\n');
    expect(parseBranchCreationSource(reflog)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseBranchCreationSource('')).toBeNull();
    expect(parseBranchCreationSource(undefined)).toBeNull();
  });
});
