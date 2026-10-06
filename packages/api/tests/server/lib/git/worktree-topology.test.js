import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi, beforeAll } from 'vitest';
import { registerGitServiceTestSupport } from './service-test-support.js';
import {
  createWorktree,
  getWorktreeBootstrapStatus,
  getBranches,
  getRepositoryRoot,
  getStatus,
  getWorktrees,
  isGitRepository,
  observeWorktreeTopology,
  removeWorktree,
  resolvePrimaryWorktreeRoot,
  resolveWorktreeTopLevel,
  subscribeWorktreeTopologyChanges,
  getDiff
} from '../../../../server/lib/git/service.js';
const { createTempDir, runGit, canRunGit } = registerGitServiceTestSupport({ afterEach, beforeAll, afterAll });


describe('worktree root resolution', () => {
  it.each(['repo', 'repo space', 'repo-\u4e2d\u6587'])('uses filesystem paths returned by Git for %s', async (name) => {
    if (!canRunGit()) return;
    const parent = createTempDir();
    const repo = path.join(parent, name);
    const subdirectory = path.join(repo, 'packages', 'app');
    fs.mkdirSync(subdirectory, { recursive: true });
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'core.autocrlf', 'false']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);

    for (const directory of [repo, subdirectory]) {
      expect(await isGitRepository(directory)).toBe(true);
      expect(fs.realpathSync(await getRepositoryRoot(directory))).toBe(fs.realpathSync(repo));
      expect(fs.realpathSync((await resolveWorktreeTopLevel(directory)).root)).toBe(fs.realpathSync(repo));
      expect((await getStatus(directory)).isClean).toBe(true);
    }

    fs.writeFileSync(path.join(repo, 'README.md'), 'before\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'after /c/keep-this-content\n');
    expect((await getBranches(subdirectory)).current).toBe('main');
    expect((await getStatus(repo)).files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'README.md', working_dir: 'M' }),
    ]));
    expect(await getDiff(repo, { path: 'README.md' })).toContain('+after /c/keep-this-content');

    const entries = await getWorktrees(subdirectory);
    expect(entries).toHaveLength(1);
    expect(fs.realpathSync(entries[0].path)).toBe(fs.realpathSync(repo));
  });

  it('creates and queries a managed worktree using native filesystem paths', async () => {
    if (!canRunGit()) return;
    const previousDataHome = process.env.XDG_DATA_HOME;
    const parent = createTempDir();
    process.env.XDG_DATA_HOME = path.join(parent, 'data space');
    try {
      const repo = path.join(parent, 'repo space');
      fs.mkdirSync(repo);
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'core.autocrlf', 'false']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), 'initial\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);

      const created = await createWorktree(repo, {
        mode: 'new', branchName: 'feature/native-paths', worktreeName: 'native-paths',
      });
      await expect.poll(
        async () => (await getWorktreeBootstrapStatus(created.path)).status,
        { timeout: 20_000 },
      ).not.toBe('pending');
      expect(await getWorktreeBootstrapStatus(created.path)).toMatchObject({ status: 'ready', error: null });
      expect(fs.readFileSync(path.join(created.path, 'README.md'), 'utf8')).toBe('initial\n');
      expect(fs.realpathSync(await getRepositoryRoot(created.path))).toBe(fs.realpathSync(created.path));
      expect(fs.realpathSync((await resolvePrimaryWorktreeRoot(created.path)).root)).toBe(fs.realpathSync(repo));
      expect((await getStatus(created.path)).isClean).toBe(true);
      const entries = await getWorktrees(created.path);
      expect(entries.map((entry) => fs.realpathSync(entry.path)).sort()).toEqual(
        [fs.realpathSync(repo), fs.realpathSync(created.path)].sort(),
      );
      await removeWorktree(repo, { directory: created.path });
      expect(fs.existsSync(created.path)).toBe(false);
      expect(await getWorktrees(repo)).toHaveLength(1);
    } finally {
      if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousDataHome;
    }
  });

  it('resolves the git toplevel for a repository subdirectory', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    const subdirectory = path.join(repo, 'packages', 'app');
    runGit(repo, ['init', '-b', 'main']);
    fs.mkdirSync(subdirectory, { recursive: true });

    expect(fs.realpathSync((await resolveWorktreeTopLevel(subdirectory)).root)).toBe(fs.realpathSync(repo));
  });

  it('resolves the primary worktree root from a linked worktree', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    const worktree = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    fs.rmSync(worktree, { recursive: true, force: true });
    runGit(repo, ['worktree', 'add', '-b', 'feature/test', worktree, 'HEAD']);

    expect(fs.realpathSync((await resolvePrimaryWorktreeRoot(worktree)).root)).toBe(fs.realpathSync(repo));
  });
});

// ---------------------------------------------------------------------------
// getWorktrees
// ---------------------------------------------------------------------------

describe('getWorktrees', () => {
  if (!canRunGit()) {
    it.skip('git binary not available', () => {});
    return;
  }

  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  afterEach(() => {
    warnSpy.mockClear();
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  it('returns an empty list for a non-git directory without warning', async () => {
    const nonGit = createTempDir();

    const result = await getWorktrees(nonGit);

    expect(result).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns the worktrees for a real git repository', async () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'init']);

    const result = await getWorktrees(repo);

    expect(Array.isArray(result)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });
  it('notifies subscribers only when another git process changes the worktree set', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    runGit(repo, ['commit', '--allow-empty', '-m', 'init']);
    const worktreePath = path.join(createTempDir(), 'feature');

    const events = [];
    const unsubscribe = subscribeWorktreeTopologyChanges((event) => events.push(event));
    try {
      await observeWorktreeTopology(repo);
      await observeWorktreeTopology(repo);
      expect(events).toHaveLength(0);

      runGit(repo, ['worktree', 'add', worktreePath, '-b', 'feature']);
      await observeWorktreeTopology(worktreePath);
      expect(events).toHaveLength(1);
      expect(events[0].directories).toEqual(expect.arrayContaining([repo, worktreePath]));

      await observeWorktreeTopology(repo);
      expect(events).toHaveLength(1);

      runGit(repo, ['worktree', 'remove', worktreePath]);
      await observeWorktreeTopology(repo);
      expect(events).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

  it('publishes worktrees this server creates and removes', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = createTempDir();
    const events = [];
    const unsubscribe = subscribeWorktreeTopologyChanges((event) => events.push(event));
    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      runGit(repo, ['commit', '--allow-empty', '-m', 'init']);
      await observeWorktreeTopology(repo);

      const created = await createWorktree(repo, {
        mode: 'new',
        worktreeName: 'published',
        branchName: 'openchamber/published',
      });
      expect(events).toHaveLength(1);
      expect(events[0].directories).toContain(repo);

      // The publish refreshed the baseline, so the next observation is quiet.
      await observeWorktreeTopology(repo);
      expect(events).toHaveLength(1);

      await removeWorktree(repo, { directory: created.path });
      expect(events).toHaveLength(2);
    } finally {
      unsubscribe();
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('flags a worktree whose directory was deleted outside git as prunable', async () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    runGit(repo, ['commit', '--allow-empty', '-m', 'init']);
    const worktreePath = path.join(createTempDir(), 'feature');
    runGit(repo, ['worktree', 'add', worktreePath, '-b', 'feature']);

    const before = await getWorktrees(repo);
    expect(before.find((entry) => entry.branch === 'feature')).toMatchObject({ prunable: false });

    fs.rmSync(worktreePath, { recursive: true, force: true });

    const after = await getWorktrees(repo);
    expect(after.find((entry) => entry.branch === 'feature')).toMatchObject({ path: expect.any(String), prunable: true });
    expect(after.find((entry) => entry.branch === 'main')).toMatchObject({ prunable: false });
  });
});
