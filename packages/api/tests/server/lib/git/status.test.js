import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, afterEach, beforeAll, afterAll } from 'vitest';
import { registerGitServiceTestSupport } from './service-test-support.js';
import { registerGitRoutes } from '../../../../server/lib/git/routes.js';
import {
  commit,
  getStatus,
  getTrackingBranch,
  isGitRepository,
  resolveBaseRefForLog,
  merge
} from '../../../../server/lib/git/service.js';
const { createTempDir, runGit, canRunGit } = registerGitServiceTestSupport({ afterEach, beforeAll, afterAll });


// ---------------------------------------------------------------------------
// resolveBaseRefForLog
// ---------------------------------------------------------------------------

describe('getStatus', () => {
  it('handles repositories without upstream tracking', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);

    await expect(getStatus(repo)).resolves.toMatchObject({ current: 'main' });
  });

  it('names the base an upstream-less branch was counted against, and only then', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'trunk']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    runGit(repo, ['commit', '--allow-empty', '-m', 'Initial commit']);
    runGit(repo, ['checkout', '-b', 'feature']);

    // No main/master or origin ref to compare with: ahead 0 proves nothing.
    await expect(getStatus(repo)).resolves.toMatchObject({ tracking: null, ahead: 0, aheadBase: null });

    runGit(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await expect(getStatus(repo)).resolves.toMatchObject({ tracking: null, ahead: 0, aheadBase: 'origin/main' });

    runGit(repo, ['commit', '--allow-empty', '-m', 'Unpublished work']);
    await expect(getStatus(repo)).resolves.toMatchObject({ tracking: null, ahead: 1, aheadBase: 'origin/main' });
  });

  it('falls back to a local main as the base, but never to the branch itself', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    const linked = path.join(createTempDir(), 'linked');
    runGit(repo, ['init', '-b', 'trunk']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    runGit(repo, ['commit', '--allow-empty', '-m', 'Initial commit']);
    runGit(repo, ['branch', 'main']);
    runGit(repo, ['worktree', 'add', '-q', linked, 'main']);
    runGit(linked, ['commit', '--allow-empty', '-m', 'Only on main']);

    // No origin: `main` must not be measured against itself.
    await expect(getStatus(linked)).resolves.toMatchObject({ current: 'main', tracking: null, aheadBase: null });

    runGit(repo, ['checkout', '-q', '-b', 'feature', 'main']);
    await expect(getStatus(repo)).resolves.toMatchObject({ current: 'feature', tracking: null, ahead: 0, aheadBase: 'main' });
  });

  it('rejects a non-git folder without using process.cwd()', async () => {
    if (!canRunGit()) return;

    const nonGit = createTempDir();
    const previousCwd = process.cwd();
    process.chdir(nonGit);
    try {
      await expect(getStatus(nonGit)).rejects.toThrow(/not a git repository/i);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('reads status for a git repo when process.cwd() is elsewhere', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    const neutralCwd = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);

    const previousCwd = process.cwd();
    process.chdir(neutralCwd);
    try {
      await expect(getStatus(repo)).resolves.toMatchObject({ current: 'main', isClean: true });
      await expect(isGitRepository(repo)).resolves.toBe(true);
      await expect(isGitRepository(neutralCwd)).resolves.toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('supports a folder with nested git repositories from a foreign cwd', async () => {
    if (!canRunGit()) return;

    const parent = createTempDir();
    const nested = path.join(parent, 'nested');
    const neutralCwd = createTempDir();
    fs.mkdirSync(nested, { recursive: true });

    runGit(parent, ['init', '-b', 'main']);
    runGit(parent, ['config', 'user.email', 'test@example.com']);
    runGit(parent, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(parent, 'README.md'), '# Parent\n');
    runGit(parent, ['add', 'README.md']);
    runGit(parent, ['commit', '-m', 'Parent commit']);

    runGit(nested, ['init', '-b', 'feature']);
    runGit(nested, ['config', 'user.email', 'test@example.com']);
    runGit(nested, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(nested, 'nested.txt'), 'nested\n');
    runGit(nested, ['add', 'nested.txt']);
    runGit(nested, ['commit', '-m', 'Nested commit']);

    const previousCwd = process.cwd();
    process.chdir(neutralCwd);
    try {
      await expect(getStatus(parent)).resolves.toMatchObject({ current: 'main' });
      await expect(getStatus(nested)).resolves.toMatchObject({ current: 'feature' });
      // Enumeration must continue when one path is not a repo.
      const results = await Promise.allSettled([
        getStatus(parent),
        getStatus(neutralCwd),
        getStatus(nested),
      ]);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect(results[1].reason?.message || String(results[1].reason)).toMatch(/not a git repository/i);
      expect(results[2].status).toBe('fulfilled');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('scopes diff stats by staged and working instead of combining a partially staged file', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    const file = 'test.txt';
    const filePath = path.join(repo, file);
    fs.writeFileSync(filePath, 'one\ntwo\nthree\n');
    runGit(repo, ['add', file]);
    runGit(repo, ['commit', '-m', 'initial']);

    // Stage one new line, then keep editing without staging another.
    fs.writeFileSync(filePath, 'one\ntwo\nthree\nstaged\n');
    runGit(repo, ['add', file]);
    fs.writeFileSync(filePath, 'one\ntwo\nthree\nstaged\nworking\n');

    const status = await getStatus(repo);

    expect(status.diffStats.staged[file]).toEqual({ insertions: 1, deletions: 0 });
    expect(status.diffStats.working[file]).toEqual({ insertions: 1, deletions: 0 });
  });

  it('scopes untracked files to working stats and staged additions to staged stats', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n');
    runGit(repo, ['add', 'tracked.txt']);
    runGit(repo, ['commit', '-m', 'initial']);

    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'a\nb\n');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'c\nd\ne\n');
    runGit(repo, ['add', 'staged.txt']);

    const status = await getStatus(repo);

    expect(status.diffStats.working['untracked.txt']).toEqual({ insertions: 2, deletions: 0 });
    expect(status.diffStats.staged['staged.txt']).toEqual({ insertions: 3, deletions: 0 });
    expect(status.diffStats.working['staged.txt']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// worktree root resolution
// ---------------------------------------------------------------------------

describe('getTrackingBranch', () => {
  const createCommittedRepo = () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    runGit(repo, ['commit', '--allow-empty', '-m', 'Initial commit']);
    return repo;
  };

  it('reports the same upstream name as status, including a gone upstream', async () => {
    if (!canRunGit()) return;

    const repo = createCommittedRepo();
    await expect(getTrackingBranch(repo)).resolves.toBeNull();

    runGit(repo, ['remote', 'add', 'origin', 'https://example.invalid/repo.git']);
    runGit(repo, ['config', 'branch.main.remote', 'origin']);
    runGit(repo, ['config', 'branch.main.merge', 'refs/heads/main']);
    await expect(getTrackingBranch(repo)).resolves.toBe('origin/main');
    expect((await getStatus(repo)).tracking).toBe('origin/main');

    runGit(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await expect(getTrackingBranch(repo)).resolves.toBe('origin/main');
  });

  it('is null for a detached HEAD and outside a repository', async () => {
    if (!canRunGit()) return;

    const repo = createCommittedRepo();
    runGit(repo, ['checkout', '--detach']);
    await expect(getTrackingBranch(repo)).resolves.toBeNull();
    await expect(getTrackingBranch(createTempDir())).resolves.toBeNull();
  });
});

describe('getStatus concurrency', () => {
  it('answers overlapping reads of one repository and reflects changes made while a read ran', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    runGit(repo, ['commit', '--allow-empty', '-m', 'Initial commit']);

    const first = getStatus(repo);
    fs.writeFileSync(path.join(repo, 'late.txt'), 'added after the first read was admitted\n');
    const second = getStatus(repo, { mode: 'light' });
    const third = getStatus(repo);

    const [firstStatus, secondStatus, thirdStatus] = await Promise.all([first, second, third]);
    expect(firstStatus.current).toBe('main');
    expect(secondStatus.files.map((file) => file.path)).toContain('late.txt');
    expect(thirdStatus.files.map((file) => file.path)).toContain('late.txt');
    // The follow-up run served both later callers at the widest requested mode.
    expect(secondStatus.diffStats).toBeDefined();
    expect(thirdStatus.diffStats).toBeDefined();
  });
});

describe('getStatus untracked directories', () => {
  const callDiffRoute = async (endpoint, query) => {
    const routes = new Map();
    registerGitRoutes({ get: (url, handler) => routes.set(url, handler), post() {}, put() {}, delete() {} });
    let status = 200;
    let body;
    await routes.get(`/api/git/${endpoint}`)({ query }, {
      status(value) { status = value; return this; },
      json(value) { body = value; },
    });
    return { status, body };
  };

  const createCommittedRepo = () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    return repo;
  };

  const writeFiles = (root, count) => {
    fs.mkdirSync(root, { recursive: true });
    for (let index = 0; index < count; index += 1) {
      fs.writeFileSync(path.join(root, `file-${String(index).padStart(5, '0')}.txt`), `${index}\n`);
    }
  };

  it('lists the files of an ordinary new directory one by one', async () => {
    if (!canRunGit()) return;

    const repo = createCommittedRepo();
    writeFiles(path.join(repo, 'feature', 'deep'), 3);
    fs.writeFileSync(path.join(repo, 'loose.txt'), 'loose\n');

    const paths = (await getStatus(repo)).files.map((file) => file.path);
    expect(paths).toEqual([
      'feature/deep/file-00000.txt',
      'feature/deep/file-00001.txt',
      'feature/deep/file-00002.txt',
      'loose.txt',
    ]);
  });

  it('keeps a directory with more than a thousand new files as one entry the diff routes explain', async () => {
    if (!canRunGit()) return;

    const repo = createCommittedRepo();
    writeFiles(path.join(repo, 'node_modules', 'pkg'), 1001);
    writeFiles(path.join(repo, 'small'), 2);

    const status = await getStatus(repo);
    expect(status.files.map((file) => file.path)).toEqual([
      'node_modules/',
      'small/file-00000.txt',
      'small/file-00001.txt',
    ]);
    expect(status.files[0]).toMatchObject({ index: '?', working_dir: '?' });

    for (const endpoint of ['diff', 'file-diff']) {
      const { status: httpStatus, body } = await callDiffRoute(endpoint, { directory: repo, path: 'node_modules/' });
      expect(httpStatus).toBe(422);
      expect(body).toEqual({ code: 'untracked_directory', error: 'Path is a directory of untracked files: node_modules/' });
    }
  });
});
