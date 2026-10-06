import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi, beforeAll } from 'vitest';
import { registerGitServiceTestSupport } from './service-test-support.js';
import { createWorktree, previewWorktreeCreate, removeWorktree } from '../../../../server/lib/git/service.js';
const { createTempDir, runGit, canRunGit } = registerGitServiceTestSupport({ afterEach, beforeAll, afterAll });

describe('createWorktree with OpenCode worktree.directory', () => {
  const initRepo = () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    return repo;
  };

  const withDataHome = (test) => async () => {
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

  it('creates and previews under a configured relative folder', withDataHome(async () => {
    if (!canRunGit()) return;

    const repo = initRepo();
    fs.writeFileSync(
      path.join(repo, 'opencode.json'),
      JSON.stringify({ worktree: { directory: '.worktrees' } }),
    );

    const preview = await previewWorktreeCreate(repo, { mode: 'new', worktreeName: 'preview-tree' });
    expect(path.basename(preview.path)).toBe('preview-tree');
    expect(fs.realpathSync(path.dirname(preview.path))).toBe(fs.realpathSync(path.join(repo, '.worktrees')));

    const created = await createWorktree(repo, {
      mode: 'new',
      branchName: 'openchamber/configured-tree',
      worktreeName: 'configured-tree',
    });
    expect(fs.realpathSync(created.path)).toBe(fs.realpathSync(path.join(repo, '.worktrees', 'configured-tree')));

    await removeWorktree(repo, { directory: created.path });
    expect(fs.existsSync(created.path)).toBe(false);
  }));

  it('uses an absolute configured folder as-is', withDataHome(async () => {
    if (!canRunGit()) return;

    const repo = initRepo();
    const target = createTempDir();
    fs.writeFileSync(
      path.join(repo, 'opencode.json'),
      JSON.stringify({ worktree: { directory: target } }),
    );

    const created = await createWorktree(repo, {
      mode: 'new',
      branchName: 'openchamber/absolute-tree',
      worktreeName: 'absolute-tree',
    });
    expect(fs.realpathSync(created.path)).toBe(fs.realpathSync(path.join(target, 'absolute-tree')));
    await removeWorktree(repo, { directory: created.path });
    expect(fs.existsSync(created.path)).toBe(false);
  }));

  it('falls back to the data-dir folder when the setting is unset', withDataHome(async (dataHome) => {
    if (!canRunGit()) return;

    const repo = initRepo();
    const projectID = runGit(repo, ['rev-list', '--max-parents=0', '--all']).trim();

    // `worktree: null` in the custom layer forces the setting off even if the
    // machine running the tests has a global `worktree.directory`.
    const previousOpenCodeConfig = process.env.OPENCODE_CONFIG;
    const customConfig = path.join(createTempDir(), 'opencode.json');
    fs.writeFileSync(customConfig, JSON.stringify({ worktree: null }));
    process.env.OPENCODE_CONFIG = customConfig;
    try {
      const created = await createWorktree(repo, {
        mode: 'new',
        branchName: 'openchamber/fallback-tree',
        worktreeName: 'fallback-tree',
      });

      expect(fs.realpathSync(created.path))
        .toBe(fs.realpathSync(path.join(dataHome, 'opencode', 'worktree', projectID, 'fallback-tree')));
    } finally {
      if (previousOpenCodeConfig === undefined) {
        delete process.env.OPENCODE_CONFIG;
      } else {
        process.env.OPENCODE_CONFIG = previousOpenCodeConfig;
      }
    }
  }));

  it('still removes a leftover under the data-dir root after the setting moves new worktrees', withDataHome(async (dataHome) => {
    if (!canRunGit()) return;

    const repo = initRepo();
    const projectID = runGit(repo, ['rev-list', '--max-parents=0', '--all']).trim();
    const legacyOrphan = path.join(dataHome, 'opencode', 'worktree', projectID, 'legacy-orphan');
    fs.mkdirSync(legacyOrphan, { recursive: true });
    fs.writeFileSync(path.join(legacyOrphan, 'leftover.txt'), 'x');

    fs.writeFileSync(
      path.join(repo, 'opencode.json'),
      JSON.stringify({ worktree: { directory: '.worktrees' } }),
    );

    await removeWorktree(repo, { directory: legacyOrphan });
    expect(fs.existsSync(legacyOrphan)).toBe(false);
  }));

  it('leaves an unregistered directory alone when the configured folder is the repository parent', withDataHome(async () => {
    if (!canRunGit()) return;

    const parent = createTempDir();
    const repo = path.join(parent, 'project');
    fs.mkdirSync(repo);
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    fs.writeFileSync(path.join(repo, 'opencode.json'), JSON.stringify({ worktree: { directory: '..' } }));

    const sibling = path.join(parent, 'sibling-project');
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'keep.txt'), 'x');

    await removeWorktree(repo, { directory: sibling });
    expect(fs.existsSync(path.join(sibling, 'keep.txt'))).toBe(true);
  }));

  it('still removes a worktree when the project config cannot be read', withDataHome(async (dataHome) => {
    if (!canRunGit()) return;

    const repo = initRepo();
    const projectID = runGit(repo, ['rev-list', '--max-parents=0', '--all']).trim();
    const legacyOrphan = path.join(dataHome, 'opencode', 'worktree', projectID, 'unreadable-orphan');
    fs.mkdirSync(legacyOrphan, { recursive: true });
    fs.writeFileSync(path.join(legacyOrphan, 'leftover.txt'), 'x');

    // A directory where the config file is expected makes the read throw. A
    // removal must not depend on the config being readable, so it falls back to
    // the data-dir root instead of failing.
    fs.mkdirSync(path.join(repo, 'opencode.json'));

    await expect(removeWorktree(repo, { directory: legacyOrphan })).resolves.toBe(true);
    expect(fs.existsSync(legacyOrphan)).toBe(false);
  }));
});
