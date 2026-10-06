import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi, beforeAll } from 'vitest';
import { registerGitServiceTestSupport } from './service-test-support.js';
import {
  createWorktree,
  removeWorktree
} from '../../../../server/lib/git/service.js';
const { createTempDir, runGit, canRunGit, createRemovalWorktree, installGitDirectoryLink } = registerGitServiceTestSupport({ afterEach, beforeAll, afterAll });

const canRunGitAnnex = () => {
  try {
    execFileSync('git-annex', ['version'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};

describe('removeWorktree', () => {
  it.each(['primary', 'foreign', 'escaped'])('rejects a .git symlink to %s metadata without deleting the worktree or branch', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    let target;
    if (kind === 'primary') {
      target = path.join(fixture.repo, '.git');
    } else if (kind === 'foreign') {
      target = createRemovalWorktree().metadata;
    } else {
      const outside = path.join(createTempDir(), 'metadata');
      fs.cpSync(fixture.metadata, outside, { recursive: true });
      target = path.join(path.dirname(fixture.metadata), 'escaped');
      fs.symlinkSync(outside, target, 'dir');
    }
    const linkTarget = installGitDirectoryLink({ ...fixture, metadata: target }, true);
    const canary = path.join(target, 'canary');
    fs.writeFileSync(canary, 'untouched\n');

    await expect(removeWorktree(fixture.repo, {
      directory: fixture.worktree,
      deleteLocalBranch: true,
    })).rejects.toThrow('outside this repository\'s worktree metadata');

    expect(fs.readlinkSync(fixture.gitEntry)).toBe(linkTarget);
    expect(fs.readFileSync(canary, 'utf8')).toBe('untouched\n');
    expect(fs.readFileSync(path.join(fixture.worktree, 'README.md'), 'utf8')).toBe('# Test\n');
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it('rejects a .git symlink whose metadata has a different commondir', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const linkTarget = installGitDirectoryLink(fixture);
    const foreignCommonDirectory = path.join(createRemovalWorktree().repo, '.git');
    fs.writeFileSync(path.join(fixture.metadata, 'commondir'), `${foreignCommonDirectory}\n`);

    await expect(removeWorktree(fixture.repo, {
      directory: fixture.worktree,
      deleteLocalBranch: true,
    })).rejects.toThrow('different common directory');

    expect(fs.readlinkSync(fixture.gitEntry)).toBe(linkTarget);
    expect(fs.existsSync(fixture.metadata)).toBe(true);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it('rejects a metadata backlink to another registered worktree', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const otherWorktree = path.join(createTempDir(), 'other');
    runGit(fixture.repo, ['worktree', 'add', '-b', 'feature/other', otherWorktree]);
    const otherGitEntry = path.join(otherWorktree, '.git');
    const otherMetadata = fs.readFileSync(otherGitEntry, 'utf8').slice('gitdir: '.length).trim();
    const linkTarget = installGitDirectoryLink({ ...fixture, metadata: otherMetadata }, true);

    await expect(removeWorktree(fixture.repo, {
      directory: fixture.worktree,
      deleteLocalBranch: true,
    })).rejects.toThrow('backlink does not name this worktree');

    expect(fs.readlinkSync(fixture.gitEntry)).toBe(linkTarget);
    expect(runGit(otherWorktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature/other');
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it('rejects a metadata backlink to a different entry that resolves to the same directory', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const metadata = path.join(path.dirname(fixture.metadata), 'wrong-backlink');
    const otherGitEntry = path.join(fixture.worktree, '.git.other');
    fs.cpSync(fixture.metadata, metadata, { recursive: true });
    fs.writeFileSync(path.join(metadata, 'gitdir'), `${otherGitEntry}\n`);
    fs.symlinkSync(metadata, otherGitEntry, 'dir');
    const linkTarget = installGitDirectoryLink({ ...fixture, metadata }, true);

    await expect(removeWorktree(fixture.repo, {
      directory: fixture.worktree,
      deleteLocalBranch: true,
    })).rejects.toThrow('backlink does not name this worktree');

    expect(fs.readlinkSync(fixture.gitEntry)).toBe(linkTarget);
    expect(fs.readlinkSync(otherGitEntry)).toBe(metadata);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it.each([false, true])('protects the primary workspace with a .git directory symlink, absolute=%s', async (absolute) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const gitEntry = path.join(fixture.repo, '.git');
    const metadata = path.join(fixture.repo, 'git-metadata');
    fs.renameSync(gitEntry, metadata);
    const linkTarget = absolute ? metadata : 'git-metadata';
    fs.symlinkSync(linkTarget, gitEntry, 'dir');
    const disposeInstance = vi.fn();

    await expect(removeWorktree(fixture.repo, {
      directory: fixture.repo,
      deleteLocalBranch: true,
      disposeInstance,
    })).rejects.toThrow('Cannot remove the primary workspace');

    expect(disposeInstance).not.toHaveBeenCalled();
    expect(fs.readlinkSync(gitEntry)).toBe(linkTarget);
    expect(runGit(fixture.repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
    expect(fs.readFileSync(path.join(fixture.repo, 'README.md'), 'utf8')).toBe('# Test\n');
  });

  it('leaves an unregistered unmanaged directory and its .git symlink untouched', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const orphan = createTempDir();
    const gitEntry = path.join(orphan, '.git');
    fs.symlinkSync(fixture.metadata, gitEntry, 'dir');
    const disposeInstance = vi.fn();

    await expect(removeWorktree(fixture.repo, { directory: orphan, disposeInstance })).resolves.toBe(true);

    expect(disposeInstance).not.toHaveBeenCalled();
    expect(fs.readlinkSync(gitEntry)).toBe(fixture.metadata);
    expect(fs.existsSync(fixture.metadata)).toBe(true);
    expect(fs.existsSync(fixture.worktree)).toBe(true);
  });

  it('forgets unmanaged orphan worktree entries without deleting files', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const repo = createTempDir();
      const sentinel = createTempDir();
      const canary = path.join(sentinel, 'canary.txt');

      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);
      fs.writeFileSync(canary, 'sentinel');

      const disposeInstance = vi.fn();
      await expect(removeWorktree(repo, {
        directory: sentinel,
        deleteLocalBranch: false,
        disposeInstance,
      })).resolves.toBe(true);
      expect(fs.existsSync(canary)).toBe(true);
      expect(disposeInstance).not.toHaveBeenCalled();
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('disposes the registered worktree instance before git removes the directory', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = createTempDir();

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      runGit(repo, ['commit', '--allow-empty', '-m', 'init']);

      const created = await createWorktree(repo, {
        mode: 'new',
        branchName: 'feature/dispose-order',
        worktreeName: 'dispose-order',
      });
      const targetRealPath = fs.realpathSync(created.path);

      let observed = null;
      const disposeInstance = vi.fn(async (worktreeDirectory) => {
        observed = {
          realPath: fs.realpathSync(worktreeDirectory),
          directoryExists: fs.existsSync(worktreeDirectory),
        };
      });

      await expect(removeWorktree(repo, {
        directory: created.path,
        disposeInstance,
      })).resolves.toBe(true);

      expect(disposeInstance).toHaveBeenCalledTimes(1);
      expect(observed).toEqual({ realPath: targetRealPath, directoryExists: true });
      expect(fs.existsSync(created.path)).toBe(false);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('warns about a failed instance disposal and still removes the worktree', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = createTempDir();

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      runGit(repo, ['commit', '--allow-empty', '-m', 'init']);

      const created = await createWorktree(repo, {
        mode: 'new',
        branchName: 'feature/dispose-failure',
        worktreeName: 'dispose-failure',
      });

      const disposeInstance = vi.fn(async () => {
        throw new Error('OpenCode API URL is not available');
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await expect(removeWorktree(repo, {
          directory: created.path,
          disposeInstance,
        })).resolves.toBe(true);

        expect(disposeInstance).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(created.path)).toBe(false);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(created.path),
          'OpenCode API URL is not available'
        );
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('never disposes the primary workspace', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = createTempDir();

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      runGit(repo, ['commit', '--allow-empty', '-m', 'init']);

      const disposeInstance = vi.fn();
      await expect(removeWorktree(repo, {
        directory: repo,
        disposeInstance,
      })).rejects.toThrow('Cannot remove the primary workspace');
      expect(disposeInstance).not.toHaveBeenCalled();
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('prunes the metadata a half-finished removal left behind', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    const worktree = path.join(createTempDir(), 'half-removed');
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    runGit(repo, ['commit', '--allow-empty', '-m', 'Initial commit']);
    runGit(repo, ['worktree', 'add', '-b', 'half', worktree]);
    // What a Windows lock leaves: git deleted these files, then stopped.
    const metadata = path.join(repo, '.git', 'worktrees', 'half-removed');
    for (const name of ['gitdir', 'HEAD', 'index']) fs.rmSync(path.join(metadata, name), { force: true });

    await expect(removeWorktree(repo, { directory: worktree })).resolves.toBe(true);
    expect(fs.existsSync(metadata)).toBe(false);
  });
  describe.skipIf(process.platform === 'win32' || !canRunGit() || !canRunGitAnnex())('git-annex integration', () => {
    const payload = 'git-annex worktree removal test payload\n';
    const annexGit = (cwd, args) => execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });

    const allowFixtureCleanup = (directory) => {
      // Annex object directories are read-only. Only visit owned directories,
      // never targets of symlinks within the fixture.
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) allowFixtureCleanup(path.join(directory, entry.name));
      }
    };

    const withAnnexWorktree = async (check) => {
      const root = fs.realpathSync(createTempDir());
      const repo = path.join(root, 'repository');
      const worktree = path.join(root, 'linked');
      const home = path.join(root, 'home');
      fs.mkdirSync(repo);
      fs.mkdirSync(home);

      try {
        for (const name of Object.keys(process.env)) {
          if (name.startsWith('GIT_')) vi.stubEnv(name, undefined);
        }
        vi.stubEnv('HOME', home);
        vi.stubEnv('XDG_CONFIG_HOME', path.join(home, 'config'));
        vi.stubEnv('XDG_DATA_HOME', path.join(home, 'data'));
        vi.stubEnv('XDG_CACHE_HOME', path.join(home, 'cache'));
        vi.stubEnv('GIT_CONFIG_GLOBAL', os.devNull);
        vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
        vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
        // A nonempty path keeps these local operations from discovering GnuPG.
        vi.stubEnv('SSH_AUTH_SOCK', path.join(home, 'unused-agent.sock'));

        annexGit(repo, ['init', '-b', 'main']);
        annexGit(repo, ['config', 'user.email', 'test@example.com']);
        annexGit(repo, ['config', 'user.name', 'Test User']);
        annexGit(repo, ['annex', 'init', 'removal test primary']);
        fs.writeFileSync(path.join(repo, 'README.md'), '# Annex removal test\n');
        fs.writeFileSync(path.join(repo, 'payload.dat'), payload);
        annexGit(repo, ['add', 'README.md']);
        annexGit(repo, ['annex', 'add', 'payload.dat']);
        annexGit(repo, ['commit', '-m', 'annex fixture']);
        const branch = 'feature/annex-remove';
        annexGit(repo, ['worktree', 'add', '-b', branch, worktree]);
        annexGit(worktree, ['annex', 'init', 'removal test linked']);

        const gitEntry = path.join(worktree, '.git');
        expect(fs.lstatSync(gitEntry).isSymbolicLink()).toBe(true);
        expect(fs.statSync(gitEntry).isDirectory()).toBe(true);
        const linkTarget = fs.readlinkSync(gitEntry, { encoding: 'buffer' });
        const metadata = fs.realpathSync(gitEntry);
        const branchHead = annexGit(repo, ['rev-parse', branch]).trim();
        expect(fs.readFileSync(path.join(worktree, 'payload.dat'), 'utf8')).toBe(payload);
        expect(annexGit(repo, ['worktree', 'list', '--porcelain'])).toContain(worktree);

        await check({ repo, worktree, gitEntry, metadata, linkTarget, branch, branchHead });
      } finally {
        try {
          allowFixtureCleanup(root);
        } finally {
          vi.unstubAllEnvs();
        }
      }
    };

    it.each([false, true])('removes a worktree initialized by git-annex with deleteLocalBranch=%s', async (deleteLocalBranch) => {
      await withAnnexWorktree(async (fixture) => {
        const disposals = [];
        await expect(removeWorktree(fixture.repo, {
          directory: fixture.worktree,
          deleteLocalBranch,
          disposeInstance: async (directory) => {
            disposals.push({
              directory,
              linkTarget: fs.readlinkSync(fixture.gitEntry, { encoding: 'buffer' }),
            });
          },
        })).resolves.toBe(true);

        expect(disposals).toEqual([{ directory: fixture.worktree, linkTarget: fixture.linkTarget }]);
        expect(fs.existsSync(fixture.worktree)).toBe(false);
        expect(fs.existsSync(fixture.metadata)).toBe(false);
        expect(annexGit(fixture.repo, ['worktree', 'list', '--porcelain'])).not.toContain(fixture.worktree);
        if (deleteLocalBranch) {
          expect(() => annexGit(fixture.repo, ['show-ref', '--verify', `refs/heads/${fixture.branch}`])).toThrow();
        } else {
          expect(annexGit(fixture.repo, ['rev-parse', fixture.branch]).trim()).toBe(fixture.branchHead);
        }
        expect(fs.readFileSync(path.join(fixture.repo, 'payload.dat'), 'utf8')).toBe(payload);
        annexGit(fixture.repo, ['annex', 'fsck', 'payload.dat']);
      });
    }, 60_000);

    it('restores the git-annex symlink and preserves the branch and annex content after locked removal fails', async () => {
      await withAnnexWorktree(async (fixture) => {
        const entries = fs.readdirSync(fixture.worktree).sort();
        annexGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
        const metadataEntries = fs.readdirSync(fixture.metadata).sort();
        const gitdir = fs.readFileSync(path.join(fixture.metadata, 'gitdir'));
        const commondir = fs.readFileSync(path.join(fixture.metadata, 'commondir'));

        await expect(removeWorktree(fixture.repo, {
          directory: fixture.worktree,
          deleteLocalBranch: true,
        })).rejects.toThrow(/locked/);

        expect(fs.readdirSync(fixture.metadata).sort()).toEqual(metadataEntries);
        expect(fs.readFileSync(path.join(fixture.metadata, 'gitdir'))).toEqual(gitdir);
        expect(fs.readFileSync(path.join(fixture.metadata, 'commondir'))).toEqual(commondir);
        expect(fs.lstatSync(fixture.gitEntry).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(fixture.gitEntry, { encoding: 'buffer' })).toEqual(fixture.linkTarget);
        expect(fs.statSync(fixture.metadata).isDirectory()).toBe(true);
        expect(annexGit(fixture.repo, ['rev-parse', fixture.branch]).trim()).toBe(fixture.branchHead);
        expect(annexGit(fixture.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(fixture.branch);
        expect(fs.readdirSync(fixture.worktree).sort()).toEqual(entries);
        expect(fs.readFileSync(path.join(fixture.worktree, 'payload.dat'), 'utf8')).toBe(payload);
        annexGit(fixture.worktree, ['annex', 'fsck', 'payload.dat']);
      });
    }, 60_000);
  });
});
