import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { registerGitServiceTestSupport } from './service-test-support.js';
import { registerGitRoutes } from '../../../../server/lib/git/routes.js';
import {
  commit,
  getStatus,
  resolveBaseRefForLog,
  applyHunk,
  getDiff,
  getPathDiff,
  revertFile,
  getUntrackedDiffs,
  getFileDiff,
  merge
} from '../../../../server/lib/git/service.js';
const { createTempDir, runGit, createRepositoryWithRemote, canRunGit, createTempRepo } = registerGitServiceTestSupport({ afterEach, beforeAll, afterAll });


// ---------------------------------------------------------------------------
// resolveBaseRefForLog
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// applyHunk (per-hunk stage / unstage / discard)
// ---------------------------------------------------------------------------

// Exercise the actual client splitter against the server apply boundary.
import { splitPatchIntoHunks as splitHunks } from '../../../../../ui/src/lib/diff/patchFileDiff.ts';

const writeFile = (repo, name, contents) =>
  fs.promises.writeFile(path.join(repo, name), contents, 'utf8');

// Build a 20-line file so changes on line 1 and line 20 stay in separate hunks
// (default 3-line diff context would merge closer edits into one hunk).
const makeFile = (first, last) =>
  [first, ...Array.from({ length: 18 }, (_, i) => `line${i + 2}`), last].join('\n') + '\n';
const ORIGINAL_FILE = makeFile('line1', 'line20');
const EDITED_FILE = makeFile('TOP', 'BOTTOM');

const readWorking = (repo) => fs.promises.readFile(path.join(repo, 'file.txt'), 'utf8').then((c) => c.replace(/\r\n/g, '\n'));
const readStaged = async (git) => (await git.raw(['show', ':file.txt'])).replace(/\r\n/g, '\n');

describe('applyHunk', () => {
  it('stages successive hunks and never discards a stale staged or committed patch', async () => {
    if (!canRunGit()) return;
    const { tmpDir, git } = await createTempRepo();
    const original = Array.from({ length: 60 }, (_, index) => `line${index}`);
    const changed = [...original];
    changed[1] = 'FIRST'; changed[25] = 'SECOND'; changed[50] = 'THIRD';
    await writeFile(tmpDir, 'file.txt', original.join('\n') + '\n');
    await git.add('file.txt'); await git.commit('Initial');
    await writeFile(tmpDir, 'file.txt', changed.join('\n') + '\n');
    const historical = splitHunks(await getDiff(tmpDir, { path: 'file.txt' }));
    expect(historical).toHaveLength(3);
    await applyHunk(tmpDir, 'file.txt', { patch: historical[0], action: 'stage' });
    const remaining = splitHunks(await getDiff(tmpDir, { path: 'file.txt' }));
    expect(remaining).toHaveLength(2);
    await applyHunk(tmpDir, 'file.txt', { patch: remaining[0], action: 'stage' });
    const stalePath = path.join(tmpDir, 'stale.patch');
    await fs.promises.writeFile(stalePath, historical[0]);
    // Git's reverse applicability check accepts it, but it is no longer an
    // unstaged hunk. The server must reject it before touching the working file.
    await git.raw(['apply', '--reverse', '--check', stalePath]);
    await expect(applyHunk(tmpDir, 'file.txt', { patch: historical[0], action: 'discard' })).rejects.toThrow('refresh and try again');
    expect(await readWorking(tmpDir)).toBe(changed.join('\n') + '\n');
    const last = splitHunks(await getDiff(tmpDir, { path: 'file.txt' }));
    expect(last).toHaveLength(1);
    await applyHunk(tmpDir, 'file.txt', { patch: last[0], action: 'discard' });
    changed[50] = original[50];
    expect(await readWorking(tmpDir)).toBe(changed.join('\n') + '\n');
    expect(await readStaged(git)).toBe(changed.join('\n') + '\n');
    const staged = splitHunks(await getDiff(tmpDir, { path: 'file.txt', staged: true }));
    await applyHunk(tmpDir, 'file.txt', { patch: staged[0], action: 'unstage' });
    expect(await readWorking(tmpDir)).toBe(changed.join('\n') + '\n');
    await git.add('file.txt'); await git.commit('Committed changes');
    await expect(applyHunk(tmpDir, 'file.txt', { patch: historical[0], action: 'discard' })).rejects.toThrow('refresh and try again');
  });

  it.each(['crlf', 'mixed'])('preserves %s file bytes through stage, unstage and discard', async (endings) => {
    if (!canRunGit()) return;
    const { tmpDir, git } = await createTempRepo();
    await git.addConfig('core.autocrlf', 'false');
    const serialize = (first, last) => Array.from({ length: 30 }, (_, index) => {
      const text = index === 0 ? first : index === 29 ? last : `line${index}`;
      return text + (endings === 'crlf' || index % 2 === 0 ? '\r\n' : '\n');
    }).join('');
    const original = serialize('first', 'last');
    const edited = serialize('FIRST', 'LAST');
    await writeFile(tmpDir, 'file.txt', original);
    await git.add('file.txt'); await git.commit('Initial');
    await writeFile(tmpDir, 'file.txt', edited);
    const hunks = splitHunks(await getDiff(tmpDir, { path: 'file.txt' }));
    await applyHunk(tmpDir, 'file.txt', { patch: hunks[0], action: 'stage' });
    expect(await git.raw(['show', ':file.txt'])).toBe(serialize('FIRST', 'last'));
    const staged = splitHunks(await getDiff(tmpDir, { path: 'file.txt', staged: true }));
    await applyHunk(tmpDir, 'file.txt', { patch: staged[0], action: 'unstage' });
    expect(await git.raw(['show', ':file.txt'])).toBe(original);
    const working = splitHunks(await getDiff(tmpDir, { path: 'file.txt' }));
    await applyHunk(tmpDir, 'file.txt', { patch: working[0], action: 'discard' });
    expect(await fs.promises.readFile(path.join(tmpDir, 'file.txt'), 'utf8')).toBe(serialize('first', 'LAST'));
  });

  it('rejects extra files hidden before the requested patch', async () => {
    if (!canRunGit()) return;
    const { tmpDir, git } = await createTempRepo();
    for (const name of ['file.txt', 'other.txt']) await writeFile(tmpDir, name, ORIGINAL_FILE);
    await git.add('.'); await git.commit('Initial');
    for (const name of ['file.txt', 'other.txt']) await writeFile(tmpDir, name, EDITED_FILE);
    const other = splitHunks(await getDiff(tmpDir, { path: 'other.txt' }))[0];
    const requested = splitHunks(await getDiff(tmpDir, { path: 'file.txt' }))[0];
    await expect(applyHunk(tmpDir, 'file.txt', { patch: requested + other, action: 'stage' })).rejects.toThrow('refresh and try again');
    expect(await git.raw(['diff', '--cached'])).toBe('');
  });

  it('rejects an invalid action or a patch without a hunk header', async () => {
    const { tmpDir } = await createTempRepo();
    await expect(applyHunk(tmpDir, 'file.txt', { patch: '@@ -1 +1 @@\n a\n', action: 'bogus' })).rejects.toThrow(
      'Invalid hunk action'
    );
    await expect(applyHunk(tmpDir, 'file.txt', { patch: 'no hunk here', action: 'stage' })).rejects.toThrow(
      'hunk header'
    );
  });

  it('stages a single hunk while leaving the rest unstaged', async () => {
    if (!canRunGit()) return;
    const { tmpDir, git } = await createTempRepo();
    await writeFile(tmpDir, 'file.txt', ORIGINAL_FILE);
    await git.add('file.txt');
    await git.commit('Initial');

    await writeFile(tmpDir, 'file.txt', EDITED_FILE);
    const diff = await getDiff(tmpDir, { path: 'file.txt' });
    const hunks = splitHunks(diff);
    expect(hunks.length).toBe(2);

    await applyHunk(tmpDir, 'file.txt', { patch: hunks[0], action: 'stage' });

    expect(await readStaged(git)).toBe(makeFile('TOP', 'line20'));
    expect(await readWorking(tmpDir)).toBe(EDITED_FILE);
  });

  it('discards a single hunk from the working tree', async () => {
    if (!canRunGit()) return;
    const { tmpDir, git } = await createTempRepo();
    await writeFile(tmpDir, 'file.txt', ORIGINAL_FILE);
    await git.add('file.txt');
    await git.commit('Initial');

    await writeFile(tmpDir, 'file.txt', EDITED_FILE);
    const diff = await getDiff(tmpDir, { path: 'file.txt' });
    const hunks = splitHunks(diff);
    expect(hunks.length).toBe(2);

    await applyHunk(tmpDir, 'file.txt', { patch: hunks[1], action: 'discard' });

    expect(await readWorking(tmpDir)).toBe(makeFile('TOP', 'line20'));
  });

  it('unstages a single hunk from the index', async () => {
    if (!canRunGit()) return;
    const { tmpDir, git } = await createTempRepo();
    await writeFile(tmpDir, 'file.txt', ORIGINAL_FILE);
    await git.add('file.txt');
    await git.commit('Initial');

    await writeFile(tmpDir, 'file.txt', EDITED_FILE);
    await git.add('file.txt');

    const stagedDiff = await getDiff(tmpDir, { path: 'file.txt', staged: true });
    const hunks = splitHunks(stagedDiff);
    expect(hunks.length).toBe(2);

    await applyHunk(tmpDir, 'file.txt', { patch: hunks[0], action: 'unstage' });

    // Only the first hunk (line1 -> TOP) was reverted in the index;
    // the second hunk (BOTTOM) stays staged.
    expect(await readStaged(git)).toBe(makeFile('line1', 'BOTTOM'));
  });

  it('rejects a patch whose target path does not match the requested file', async () => {
    if (!canRunGit()) return;
    const { tmpDir, git } = await createTempRepo();
    await writeFile(tmpDir, 'file.txt', ORIGINAL_FILE);
    await git.add('file.txt');
    await git.commit('Initial');
    await writeFile(tmpDir, 'file.txt', makeFile('CHANGED', 'line20'));

    const diff = await getDiff(tmpDir, { path: 'file.txt' });
    const [hunk] = splitHunks(diff);
    const retargeted = hunk.replace(/file\.txt/g, 'other.txt');
    await expect(applyHunk(tmpDir, 'file.txt', { patch: retargeted, action: 'stage' })).rejects.toThrow(
      'patch target path does not match'
    );
  });

  it.each(['file name.txt', 'зміни.txt'])('accepts hunk patches for %s', async (filePath) => {
    if (!canRunGit()) return;
    const { tmpDir, git } = await createTempRepo();
    await writeFile(tmpDir, filePath, ORIGINAL_FILE);
    await git.add(filePath);
    await git.commit('Initial');

    await writeFile(tmpDir, filePath, EDITED_FILE);
    const diff = await getDiff(tmpDir, { path: filePath });
    const hunks = splitHunks(diff);
    expect(hunks.length).toBe(2);

    await applyHunk(tmpDir, filePath, { patch: hunks[0], action: 'stage' });

    const staged = (await git.raw(['show', `:${filePath}`])).replace(/\r\n/g, '\n');
    expect(staged).toBe(makeFile('TOP', 'line20'));
  });
});

describe.runIf(canRunGit())('untracked diffs', () => {
  it.each(['false', 'warn'])('returns only the patch with core.safecrlf=%s', async (safecrlf) => {
    const { tmpDir, git } = await createTempRepo();
    await git.addConfig('core.autocrlf', 'true');
    await git.addConfig('core.safecrlf', safecrlf);
    fs.writeFileSync(path.join(tmpDir, 'new file.txt'), 'first\nsecond\n');

    // Confirm this fixture produces a real diff exit, including stderr in the warning case.
    let expectedPatch;
    try {
      runGit(tmpDir, ['diff', '--no-color', '--full-index', '--no-index', '--', '/dev/null', 'new file.txt']);
      throw new Error('Expected git diff to exit with differences');
    } catch (error) {
      expect(error.status).toBe(1);
      expectedPatch = error.stdout;
      if (safecrlf === 'warn') {
        expect(error.stderr).toContain('LF will be replaced by CRLF');
      }
    }

    const diff = await getDiff(tmpDir, { path: 'new file.txt' });
    expect(diff).toBe(expectedPatch);
    expect(diff).toContain('+first\n+second\n');
    expect(diff).not.toContain('warning:');
    expect(await getUntrackedDiffs(tmpDir, ['new file.txt'])).toEqual([diff]);
  });

  it('accepts an empty untracked file without a process error', async () => {
    const { tmpDir } = await createTempRepo();
    fs.writeFileSync(path.join(tmpDir, 'empty.txt'), '');
    const diff = await getDiff(tmpDir, { path: 'empty.txt' });
    expect(diff).toContain('new file mode 100644');
    expect(diff).not.toContain('@@');
    expect(await getUntrackedDiffs(tmpDir, ['empty.txt'])).toEqual([diff]);
  });

  it('rejects fatal conversion errors while preserving other batch entries', async () => {
    const { tmpDir } = await createTempRepo();
    runGit(tmpDir, ['config', 'diff.broken.textconv', 'false']);
    fs.writeFileSync(path.join(tmpDir, '.gitattributes'), 'bad.txt diff=broken\n');
    fs.writeFileSync(path.join(tmpDir, 'first.safe'), 'first\n');
    fs.writeFileSync(path.join(tmpDir, 'bad.txt'), 'bad\n');
    fs.writeFileSync(path.join(tmpDir, 'last.safe'), 'last\n');

    await expect(getDiff(tmpDir, { path: 'bad.txt' })).rejects.toThrow('unable to read files to diff');
    const diffs = await getUntrackedDiffs(tmpDir, ['first.safe', 'bad.txt', 'last.safe'], { concurrency: 1 });
    expect(diffs).toHaveLength(3);
    expect(diffs[0]).toContain('+first\n');
    expect(diffs[1]).toBe('');
    expect(diffs[2]).toContain('+last\n');
  });

  it('rejects truncated patches when the process output exceeds the buffer limit', async () => {
    const { tmpDir } = await createTempRepo();
    fs.writeFileSync(path.join(tmpDir, 'large.txt'), 'x'.repeat(21 * 1024 * 1024) + '\n');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(getDiff(tmpDir, { path: 'large.txt' })).rejects.toThrow('maxBuffer');
      expect(await getUntrackedDiffs(tmpDir, ['large.txt'])).toEqual(['']);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('symlink diffs', () => {
  it('treats an untracked directory symlink as a link in patch and split diffs', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const { tmpDir } = await createTempRepo();
    fs.mkdirSync(path.join(tmpDir, 'source'));
    fs.symlinkSync('source', path.join(tmpDir, 'linked-source'));

    const patch = await getDiff(tmpDir, { path: 'linked-source' });
    const split = await getFileDiff(tmpDir, { path: 'linked-source' });

    expect(patch).toContain('new file mode 120000');
    expect(patch).toContain('+source');
    expect(split).toMatchObject({
      original: '',
      modified: 'source',
      isBinary: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Status paths that are not plain files (#3586)
// ---------------------------------------------------------------------------

describe.runIf(canRunGit())('diffs for status paths that are not plain files', () => {
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

  const createRepositoryWithSubmodule = () => {
    const { repository } = createRepositoryWithRemote();
    const library = createTempDir();
    runGit(library, ['init', '-b', 'main']);
    runGit(library, ['config', 'user.email', 'test@example.com']);
    runGit(library, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(library, 'lib.txt'), 'lib\n');
    runGit(library, ['add', '.']);
    runGit(library, ['commit', '-m', 'lib']);
    runGit(repository, ['-c', 'protocol.file.allow=always', 'submodule', 'add', library, 'sub']);
    runGit(repository, ['commit', '-m', 'add submodule']);
    return { repository, recorded: runGit(repository, ['rev-parse', 'HEAD:sub']).trim() };
  };

  it('answers 404 with a code when a listed file is gone before its diff is requested', async () => {
    const { repository } = createRepositoryWithRemote();
    for (const endpoint of ['diff', 'file-diff']) {
      const { status, body } = await callDiffRoute(endpoint, { directory: repository, path: 'removed.txt' });
      expect(status).toBe(404);
      expect(body).toEqual({ code: 'path_not_found', error: 'Path not found in working tree, index, or HEAD: removed.txt' });
    }
  });

  it('answers 422 for a nested repository that status lists as a directory', async () => {
    const { repository } = createRepositoryWithRemote();
    const nested = path.join(repository, 'nested');
    fs.mkdirSync(nested);
    runGit(nested, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(nested, 'inner.txt'), 'inner\n');
    expect((await getStatus(repository)).files).toContainEqual(expect.objectContaining({ path: 'nested/' }));

    for (const endpoint of ['diff', 'file-diff']) {
      const { status, body } = await callDiffRoute(endpoint, { directory: repository, path: 'nested/' });
      expect(status).toBe(422);
      expect(body.code).toBe('nested_repository');
    }
    await expect(revertFile(repository, 'nested/')).rejects.toMatchObject({ code: 'nested_repository' });
    expect(fs.existsSync(path.join(nested, 'inner.txt'))).toBe(true);
  });

  it('describes a submodule whose checked-out commit moved', async () => {
    const { repository, recorded } = createRepositoryWithSubmodule();
    const submodulePath = path.join(repository, 'sub');
    runGit(submodulePath, ['config', 'user.email', 'test@example.com']);
    runGit(submodulePath, ['config', 'user.name', 'Test']);
    runGit(submodulePath, ['commit', '--allow-empty', '-m', 'moved']);
    const moved = runGit(submodulePath, ['rev-parse', 'HEAD']).trim();
    const submodule = { headCommit: recorded, indexCommit: recorded, worktreeCommit: moved, hasTrackedChanges: false, hasUntrackedFiles: false, hasConflict: false };

    const patch = await callDiffRoute('diff', { directory: repository, path: 'sub' });
    expect(patch.status).toBe(200);
    expect(patch.body.diff).toContain(`+Subproject commit ${moved}`);
    expect(patch.body.submodule).toEqual(submodule);

    const split = await callDiffRoute('file-diff', { directory: repository, path: 'sub' });
    expect(split.body).toEqual({
      original: `Subproject commit ${recorded}\n`,
      modified: `Subproject commit ${moved}\n`,
      path: 'sub',
      isBinary: false,
      submodule,
    });
  });

  it('reports a submodule merge conflict instead of an unchanged commit', async () => {
    const { repository } = createRepositoryWithRemote();
    const library = createTempDir();
    runGit(library, ['init', '-b', 'main']);
    runGit(library, ['config', 'user.email', 'test@example.com']);
    runGit(library, ['config', 'user.name', 'Test']);
    runGit(library, ['commit', '--allow-empty', '-m', 'base']);
    runGit(library, ['checkout', '-b', 'left']);
    runGit(library, ['commit', '--allow-empty', '-m', 'left']);
    runGit(library, ['checkout', '-b', 'right', 'main']);
    runGit(library, ['commit', '--allow-empty', '-m', 'right']);
    runGit(library, ['checkout', 'main']);
    runGit(repository, ['-c', 'protocol.file.allow=always', 'submodule', 'add', library, 'sub']);
    runGit(repository, ['commit', '-m', 'add submodule']);
    const submodulePath = path.join(repository, 'sub');
    for (const [branch, commit] of [['other', 'right'], ['next', 'left']]) {
      if (branch === 'other') runGit(repository, ['checkout', '-b', 'other']);
      else runGit(repository, ['checkout', 'next']);
      runGit(submodulePath, ['checkout', commit]);
      runGit(repository, ['add', 'sub']);
      runGit(repository, ['commit', '-m', `move to ${commit}`]);
    }
    expect(() => runGit(repository, ['merge', 'other'])).toThrow();

    const { submodule } = await getPathDiff(repository, { path: 'sub' });
    expect(submodule).toMatchObject({
      headCommit: runGit(repository, ['rev-parse', 'HEAD:sub']).trim(),
      indexCommit: null,
      hasConflict: true,
    });
  });

  it('reports untracked files inside a submodule even though its patch is empty', async () => {
    const { repository, recorded } = createRepositoryWithSubmodule();
    fs.writeFileSync(path.join(repository, 'sub', 'scratch.txt'), 'scratch\n');

    const result = await getPathDiff(repository, { path: 'sub' });
    expect(result).toEqual({
      diff: '',
      submodule: { headCommit: recorded, indexCommit: recorded, worktreeCommit: recorded, hasTrackedChanges: false, hasUntrackedFiles: true, hasConflict: false },
    });
  });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------
