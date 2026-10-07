import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { registerGitServiceTestSupport } from './service-test-support.js';
import { loadSourceSections, parseSource, sourceKey } from '../../../../server/lib/walkthrough/sources.js';
import { registerGitRoutes } from '../../../../server/lib/git/routes.js';
import { commit, getRepositoryRemoteUrls, getUnpushedBranchCounts, getRangeDiff, getBranchBase, getCommitDiff, getCommitFiles, getLog, getTrackingBranch, getRangeFiles, merge, rebase } from '../../../../server/lib/git/service.js';
const { createTempDir, runGit, createRepositoryWithRemote, canRunGit, createTempRepo } = registerGitServiceTestSupport({ afterEach, beforeAll, afterAll });

describe.runIf(canRunGit())('getRepositoryRemoteUrls', () => {
  it('reports each remote as `git remote get-url [--push]` does, from one listing', async () => {
    const repository = createTempDir();
    runGit(repository, ['init', '-b', 'main']);
    runGit(repository, ['remote', 'add', 'origin', 'git@github.com:owner/repo.git']);
    runGit(repository, ['remote', 'set-url', '--push', 'origin', 'git@github.com:owner/push.git']);
    runGit(repository, ['remote', 'add', 'rewritten', 'gh:other/repo.git']);
    runGit(repository, ['config', 'url.https://github.com/.insteadOf', 'gh:']);
    runGit(repository, ['config', 'remote.bare.fetch', '+refs/heads/*:refs/remotes/bare/*']);

    const remotes = await getRepositoryRemoteUrls(repository);
    const expected = remotes.map(({ name }) => {
      const read = (args) => { try { return runGit(repository, args).trim(); } catch { return ''; } };
      const fetchUrl = read(['remote', 'get-url', name]);
      return { name, fetchUrl, pushUrl: read(['remote', 'get-url', '--push', name]) || fetchUrl };
    });

    expect(remotes).toEqual(expected);
    expect(remotes.find((remote) => remote.name === 'rewritten')?.fetchUrl).toBe('https://github.com/other/repo.git');
    expect(remotes.find((remote) => remote.name === 'origin')?.pushUrl).toBe('git@github.com:owner/push.git');
  });
});

describe.runIf(canRunGit())('getUnpushedBranchCounts', () => {
  it('counts only commits ahead of a locally known upstream', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['branch', '--set-upstream-to=origin/react', 'next']);
    fs.writeFileSync(path.join(repository, 'ahead.txt'), 'ahead\n');
    runGit(repository, ['add', 'ahead.txt']);
    runGit(repository, ['commit', '-m', 'ahead']);
    runGit(repository, ['checkout', '-b', 'no-upstream']);

    await expect(getUnpushedBranchCounts(repository, ['next', 'no-upstream', 'remotes/origin/react'])).resolves.toEqual({
      counts: { next: 1 },
    });
  });
});

describe.runIf(canRunGit())('commit comparisons', () => {
  it('shows only the selected commit and gives walkthrough the identical patch', async () => {
    const { repository } = createRepositoryWithRemote();
    fs.writeFileSync(path.join(repository, 'README.md'), 'selected version\n');
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'selected']);
    const hash = runGit(repository, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(repository, 'README.md'), 'later version\n');
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'later']);
    fs.writeFileSync(path.join(repository, 'README.md'), 'uncommitted version\n');
    const patch = await getCommitDiff(repository, { hash, path: 'README.md' });
    expect(patch).toContain('+selected version');
    expect(patch).not.toContain('later version');
    expect(patch).not.toContain('uncommitted version');
    expect((await getCommitFiles(repository, hash)).files).toEqual([
      { path: 'README.md', insertions: 1, deletions: 1, isBinary: false, changeType: 'M' },
    ]);
    const source = parseSource({ kind: 'commit', hash });
    expect(sourceKey(source)).toBe(`commit:${hash}`);
    expect((await loadSourceSections(repository, source)).sections).toEqual([{ scope: 'commit', patch }]);
    const routes = new Map();
    registerGitRoutes({
      get: (url, handler) => routes.set(url, handler), post() {}, put() {}, delete() {},
    });
    let response;
    await routes.get('/api/git/commit-diff')(
      { query: { directory: repository, hash, path: 'README.md' } },
      { json: (body) => { response = body; }, status: (code) => { throw new Error(`Unexpected status ${code}`); } },
    );
    expect(response).toEqual({ diff: patch });
  });

  it('handles root and empty commits and rejects invalid hashes', async () => {
    const { repository } = createRepositoryWithRemote();
    const root = runGit(repository, ['rev-parse', 'HEAD']).trim();
    expect(await getCommitDiff(repository, { hash: root })).toContain('+# Test');
    expect((await getCommitFiles(repository, root)).files[0].changeType).toBe('A');
    runGit(repository, ['commit', '--allow-empty', '-m', 'empty']);
    const empty = runGit(repository, ['rev-parse', 'HEAD']).trim();
    expect(await getCommitDiff(repository, { hash: empty })).toBe('');
    expect(await getCommitFiles(repository, empty)).toEqual({ files: [] });
    expect(() => parseSource({ kind: 'commit', hash: 'HEAD' })).toThrow();
    expect(() => parseSource({ kind: 'commit', hash: [root] })).toThrow();
    await expect(getCommitDiff(repository, { hash: 'HEAD' })).rejects.toThrow();
    await expect(getCommitFiles(repository, '0'.repeat(40))).rejects.toThrow();
  });

  it('keeps rename paths and original contents together, including whitespace in names', async () => {
    const { repository } = createRepositoryWithRemote();
    const destination = ' new\nname.md';
    runGit(repository, ['mv', 'README.md', destination]);
    runGit(repository, ['commit', '-m', 'rename']);
    const hash = runGit(repository, ['rev-parse', 'HEAD']).trim();
    const { files } = await getCommitFiles(repository, hash);
    expect(files).toEqual([{ path: destination, previousPath: 'README.md', changeType: 'R', insertions: 0, deletions: 0, isBinary: false }]);
    const patch = await getCommitDiff(repository, { hash, path: destination, previousPath: files[0].previousPath });
    expect(patch).toContain('rename from README.md');
    expect(patch).toContain('similarity index 100%');
  });

  it('compares a merge commit against its first parent', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['checkout', '-b', 'side']);
    fs.writeFileSync(path.join(repository, 'side.txt'), 'side\n');
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'side']);
    runGit(repository, ['checkout', 'next']);
    fs.writeFileSync(path.join(repository, 'main.txt'), 'main\n');
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'main']);
    runGit(repository, ['merge', '--no-ff', 'side', '-m', 'merge']);
    const hash = runGit(repository, ['rev-parse', 'HEAD']).trim();
    expect((await getCommitFiles(repository, hash)).files.map((file) => file.path)).toEqual(['side.txt']);
    const patch = await getCommitDiff(repository, { hash });
    expect(patch).toContain('+side');
    expect(patch).not.toContain('main.txt');
  });

  it('limits current-branch history to 50 commits without including another branch', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['checkout', '-b', 'other']);
    runGit(repository, ['commit', '--allow-empty', '-m', 'other branch only']);
    runGit(repository, ['checkout', 'next']);
    for (let index = 0; index < 51; index += 1) runGit(repository, ['commit', '--allow-empty', '-m', `current ${index}`]);
    const history = await getLog(repository, { maxCount: 50, to: 'refs/heads/next' });
    expect(history.all).toHaveLength(50);
    expect(history.all[0].message).toBe('current 50');
    expect(history.all.some((commit) => commit.message === 'other branch only')).toBe(false);
  });
});

describe.runIf(canRunGit())('Git revision arguments', () => {
  it.each([undefined, 'glob'])('preserves revision syntax with inherited MSYS=%j', async (msys) => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['branch', '--set-upstream-to=origin/react', 'next']);
    fs.writeFileSync(path.join(repository, 'feature.txt'), 'feature\n');
    runGit(repository, ['add', 'feature.txt']);
    runGit(repository, ['commit', '-m', 'feature']);

    const previousMsys = process.env.MSYS;
    if (msys === undefined) delete process.env.MSYS;
    else process.env.MSYS = msys;
    try {
      expect(await getRangeDiff(repository, { base: 'origin/react', head: 'next@{0}' })).toContain('+feature');
      expect(await getUnpushedBranchCounts(repository, ['next'])).toEqual({ counts: { next: 1 } });
      expect(process.env.MSYS).toBe(msys);
    } finally {
      if (previousMsys === undefined) delete process.env.MSYS;
      else process.env.MSYS = previousMsys;
    }
  });
});

describe.runIf(canRunGit())('getRangeDiff', () => {
  it('loads a committed deletion that no longer exists in HEAD or the working tree', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['rm', 'README.md']);
    runGit(repository, ['commit', '-m', 'delete file']);
    const diff = await getRangeDiff(repository, { base: 'origin/react', head: 'next', path: 'README.md', includeWorkingTree: true });
    expect(diff).toContain('deleted file mode');
    expect(diff).toContain('-# Test');
  });

  it('carries the working-tree option through the actual HTTP route handlers', async () => {
    const { repository } = createRepositoryWithRemote();
    fs.writeFileSync(path.join(repository, 'local.txt'), 'current local work\n');
    const routes = new Map();
    registerGitRoutes({
      get: (url, handler) => routes.set(url, handler),
      post() {},
      put() {},
      delete() {},
    });
    const query = { directory: repository, base: 'origin/react', head: 'next', includeWorkingTree: 'true' };
    for (const endpoint of ['range-diff', 'range-files']) {
      let status = 200;
      let body;
      const response = {
        status(value) { status = value; return this; },
        json(value) { body = value; },
      };
      await routes.get(`/api/git/${endpoint}`)({ query }, response);
      expect(status).toBe(200);
      if (endpoint === 'range-diff') expect(body.diff).toContain('+current local work');
      else expect(body.files).toEqual([{ path: 'local.txt', status: 'A' }]);
    }
  });

  it('does not treat a branch checked out from its own remote copy as its base', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['checkout', '-b', 'react', '--track', 'origin/react']);
    expect(await getBranchBase(repository, 'react')).toEqual({ base: null });
    runGit(repository, ['checkout', '--no-track', '-b', 'loose', 'origin/react']);
    expect(await getBranchBase(repository, 'loose')).toEqual({ base: 'origin/react' });
  });

  it('asks for a new base after restacking and compares against the selected parent', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['checkout', '-b', 'child', 'origin/react']);
    fs.writeFileSync(path.join(repository, 'child.txt'), 'child\n');
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'child']);
    expect(await getBranchBase(repository, 'child')).toEqual({ base: 'origin/react' });
    runGit(repository, ['checkout', '-b', 'parent', 'origin/react']);
    fs.writeFileSync(path.join(repository, 'parent.txt'), 'parent\n');
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'parent']);
    runGit(repository, ['checkout', 'child']);
    runGit(repository, ['rebase', 'parent']);
    expect(await getBranchBase(repository, 'child')).toEqual({ base: null });
    fs.writeFileSync(path.join(repository, 'child.txt'), 'current child\n');
    const options = { base: 'refs/heads/parent', head: 'child', includeWorkingTree: true };
    expect(await getRangeFiles(repository, options)).toEqual([{ path: 'child.txt', status: 'A' }]);
    const diff = await getRangeDiff(repository, options);
    expect(diff).toContain('+current child');
    expect(diff).not.toContain('parent.txt');
  });

  it('combines committed, staged, unstaged and untracked work without changing the real index', async () => {
    const { repository } = createRepositoryWithRemote();
    fs.writeFileSync(path.join(repository, 'README.md'), '# Committed\n');
    runGit(repository, ['add', 'README.md']);
    runGit(repository, ['commit', '-m', 'branch change']);
    fs.writeFileSync(path.join(repository, 'README.md'), '# Staged\n');
    fs.writeFileSync(path.join(repository, 'staged.txt'), 'staged only\n');
    runGit(repository, ['add', '.']);
    fs.writeFileSync(path.join(repository, 'README.md'), '# Current\n');
    fs.writeFileSync(path.join(repository, 'untracked.txt'), 'new local file\n');
    fs.writeFileSync(path.join(repository, ' leading space.txt'), 'space path\n');
    const indexBefore = fs.readFileSync(path.join(repository, '.git/index'));
    const options = { base: 'origin/react', head: 'next', includeWorkingTree: true };

    const diff = await getRangeDiff(repository, options);
    expect(diff).toContain('-# Test');
    expect(diff).toContain('+# Current');
    expect(diff).not.toContain('+# Staged');
    expect(diff).not.toContain('+# Committed');
    expect(diff).toContain('+new local file');
    expect(diff).toContain('+staged only');
    expect(await getRangeFiles(repository, options)).toEqual(expect.arrayContaining([
      { path: 'README.md', status: 'M' },
      { path: 'staged.txt', status: 'A' },
      { path: 'untracked.txt', status: 'A' },
      { path: ' leading space.txt', status: 'A' },
    ]));
    const { sections } = await loadSourceSections(repository, { kind: 'branch', baseRef: options.base, headRef: options.head });
    expect(sections).toEqual([{ scope: 'branch', patch: diff }]);
    expect(fs.readFileSync(path.join(repository, '.git/index'))).toEqual(indexBefore);

    const committed = await getRangeDiff(repository, { base: options.base, head: options.head });
    expect(committed).toContain('+# Committed');
    expect(committed).not.toContain('+new local file');
    fs.writeFileSync(path.join(repository, 'README.md'), '# Latest\n');
    expect(await getRangeDiff(repository, { ...options, path: 'README.md' })).toContain('+# Latest');
  });

  it('reports the final file after a staged deletion is recreated, and omits undone branch changes', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['rm', 'README.md']);
    fs.writeFileSync(path.join(repository, 'README.md'), '# Recreated\n');
    const options = { base: 'origin/react', head: 'next', includeWorkingTree: true };
    expect(await getRangeFiles(repository, options)).toEqual([{ path: 'README.md', status: 'M' }]);
    const diff = await getRangeDiff(repository, options);
    expect(diff).toContain('-# Test');
    expect(diff).toContain('+# Recreated');
    expect(diff.match(/diff --git/g)).toHaveLength(1);
    fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n');
    expect(await getRangeFiles(repository, options)).toEqual([]);
    expect(await getRangeDiff(repository, options)).toBe('');
  });

  it('keeps local and remote bases distinct and rejects a different checked-out branch', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['branch', 'react']);
    fs.writeFileSync(path.join(repository, 'parent.txt'), 'parent work\n');
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'parent work']);
    runGit(repository, ['branch', '-f', 'react', 'HEAD']);
    fs.writeFileSync(path.join(repository, 'child.txt'), 'child work\n');
    const options = { head: 'next', includeWorkingTree: true };
    const local = await getRangeDiff(repository, { ...options, base: 'react' });
    const remote = await getRangeDiff(repository, { ...options, base: 'origin/react' });
    expect(local).not.toContain('parent.txt');
    expect(remote).toContain('parent.txt');
    expect(local).toContain('child.txt');
    expect(await getRangeFiles(repository, { ...options, base: 'react' })).toEqual([{ path: 'child.txt', status: 'A' }]);
    runGit(repository, ['checkout', 'react']);
    await expect(getRangeDiff(repository, { ...options, base: 'origin/react' })).rejects.toThrow(/checked-out branch/);
  });

  it('includes untracked symlinks as links without reading their targets', async () => {
    const { repository } = createRepositoryWithRemote();
    const outside = path.join(createTempDir(), 'outside.txt');
    fs.writeFileSync(outside, 'must not be in a diff\n');
    fs.symlinkSync(outside, path.join(repository, 'link.txt'));
    const diff = await getRangeDiff(repository, { base: 'origin/react', head: 'next', includeWorkingTree: true });
    expect(diff).toContain('new file mode 120000');
    expect(diff).toContain(outside);
    expect(diff).not.toContain('must not be in a diff');
  });

  it('uses an explicitly selected base on a remote other than origin', async () => {
    const { repository } = createRepositoryWithRemote({ remoteName: 'upstream', defaultBranch: 'react' });
    // The selected remote ref must work without a local branch of that name.
    fs.writeFileSync(path.join(repository, 'feature.txt'), 'work\n');
    runGit(repository, ['add', 'feature.txt']);
    runGit(repository, ['commit', '-m', 'feature']);

    const diff = await getRangeDiff(repository, { base: 'upstream/react', head: 'next' });

    expect(diff).toContain('feature.txt');
    await expect(getRangeDiff(repository, { base: 'react', head: 'next' })).rejects.toThrow(/is not available locally/);
  });

  it('names an unfetched remote-only ref instead of failing with git\'s ambiguous argument (#2735)', async () => {
    const { repository } = createRepositoryWithRemote({ defaultBranch: 'react' });

    await expect(
      getRangeDiff(repository, { base: 'remotes/origin/never-fetched', head: 'next' })
    ).rejects.toThrow(/is not available locally/);
  });
});

describe.runIf(canRunGit())('getRangeFiles', () => {
  it('returns added and modified paths with their status letters', async () => {
    const { repository } = createRepositoryWithRemote();
    fs.writeFileSync(path.join(repository, 'added.txt'), 'new\n');
    fs.writeFileSync(path.join(repository, 'README.md'), '# Test\nchanged\n');
    runGit(repository, ['add', 'added.txt', 'README.md']);
    runGit(repository, ['commit', '-m', 'changes']);

    const files = await getRangeFiles(repository, { base: 'origin/react', head: 'next' });

    expect(files).toEqual(expect.arrayContaining([
      { path: 'added.txt', status: 'A' },
      { path: 'README.md', status: 'M' },
    ]));
  });

  it('reports the destination path for renamed files, including spaces', async () => {
    const { repository } = createRepositoryWithRemote();
    // The original file must exist in the base: rename detection pairs a
    // deletion against an addition relative to base, not within the branch.
    fs.writeFileSync(path.join(repository, 'old name with spaces.md'), '# Test\n');
    runGit(repository, ['add', 'old name with spaces.md']);
    runGit(repository, ['commit', '-m', 'add file to rename']);
    runGit(repository, ['push', 'origin', 'HEAD:react']);
    // Spaces in filenames exercise the -z token split: a newline split would
    // mangle these paths long before status letters matter.
    fs.renameSync(path.join(repository, 'old name with spaces.md'), path.join(repository, 'new name with spaces.md'));
    runGit(repository, ['add', '-A']);
    runGit(repository, ['commit', '-m', 'rename']);

    const files = await getRangeFiles(repository, { base: 'origin/react', head: 'next' });

    const renameEntry = files.find((file) => file.status === 'R');
    expect(renameEntry).toBeDefined();
    expect(renameEntry.path).toBe('new name with spaces.md');
    expect(files.some((file) => file.path === 'old name with spaces.md')).toBe(false);
  });

  it('reports the destination path for copied files', async () => {
    const { repository } = createRepositoryWithRemote();
    // The source must exist in the base. Copy detection needs the repository's
    // own `diff.renames=copies` setting on top of the service's -C flag; the
    // parser must survive whatever C entries git emits.
    runGit(repository, ['config', 'diff.renames', 'copies']);
    fs.writeFileSync(path.join(repository, 'copied source.md'), '# Copy me\n');
    runGit(repository, ['add', 'copied source.md']);
    runGit(repository, ['commit', '-m', 'add source']);
    runGit(repository, ['push', 'origin', 'HEAD:react']);
    fs.copyFileSync(path.join(repository, 'copied source.md'), path.join(repository, 'copied destination.md'));
    runGit(repository, ['add', '-A']);
    runGit(repository, ['commit', '-m', 'copy']);

    const files = await getRangeFiles(repository, { base: 'origin/react', head: 'next' });

    const copyEntry = files.find((file) => file.status === 'C');
    expect(copyEntry).toBeDefined();
    expect(copyEntry.path).toBe('copied destination.md');
  });
});

// ---------------------------------------------------------------------------
// getTrackingBranch
// ---------------------------------------------------------------------------
