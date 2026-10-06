import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi, beforeAll } from 'vitest';
import { registerGitServiceTestSupport } from './service-test-support.js';
import {
  removeWorktree
} from '../../../../server/lib/git/service.js';
const { createTempDir, runGit, canRunGit, createRemovalWorktree, installGitDirectoryLink, interceptGitFileReplacement } = registerGitServiceTestSupport({ afterEach, beforeAll, afterAll });


describe('removeWorktree', () => {
  it('removes a registered worktree with a relative .git directory symlink', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);

    await expect(removeWorktree(fixture.repo, {
      directory: fixture.worktree,
      deleteLocalBranch: true,
    })).resolves.toBe(true);

    expect(fs.existsSync(fixture.worktree)).toBe(false);
    expect(fs.existsSync(fixture.metadata)).toBe(false);
    expect(() => runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toThrow();
    expect(runGit(fixture.repo, ['worktree', 'list', '--porcelain'])).not.toContain(fixture.worktree);
  });

  it('removes an absolute .git directory symlink only after instance disposal', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const linkTarget = installGitDirectoryLink(fixture, true);
    const disposalStates = [];

    await expect(removeWorktree(fixture.repo, {
      directory: fixture.worktree,
      disposeInstance: async (directory) => {
        disposalStates.push({
          directory,
          linkTarget: fs.readlinkSync(fixture.gitEntry),
          metadataExists: fs.existsSync(fixture.metadata),
          branch: runGit(directory, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
        });
      },
    })).resolves.toBe(true);

    expect(disposalStates).toEqual([{
      directory: fixture.worktree,
      linkTarget,
      metadataExists: true,
      branch: 'feature/remove',
    }]);
    expect(fs.existsSync(fixture.worktree)).toBe(false);
    expect(fs.existsSync(fixture.metadata)).toBe(false);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it.each([false, true])('removes a standard .git file with deleteLocalBranch=%s', async (deleteLocalBranch) => {
    if (!canRunGit()) return;
    const fixture = createRemovalWorktree();
    expect(fs.lstatSync(fixture.gitEntry).isFile()).toBe(true);
    const renameSpy = vi.spyOn(fs.promises, 'rename');
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch,
      })).resolves.toBe(true);
      expect(renameSpy).not.toHaveBeenCalled();
    } finally {
      renameSpy.mockRestore();
    }

    expect(fs.existsSync(fixture.worktree)).toBe(false);
    expect(fs.existsSync(fixture.metadata)).toBe(false);
    if (deleteLocalBranch) {
      expect(() => runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toThrow();
    } else {
      expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
    }
  });

  it.each(['file', 'symlink'])('preserves a concurrent .git %s installed before conversion claims the entry', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const originalTarget = installGitDirectoryLink(fixture);
    const concurrentContents = kind === 'file'
      ? `gitdir: ${fixture.metadata}\nconcurrent entry must survive\n`
      : `./${originalTarget}`;
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const branchHead = runGit(fixture.repo, ['rev-parse', 'feature/remove']).trim();
    const rename = fs.promises.rename.bind(fs.promises);
    let injected = false;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      const changesGitEntry = (source === fixture.gitEntry && destination.startsWith(`${fixture.gitEntry}.openchamber-`))
        || (destination === fixture.gitEntry && source.startsWith(`${fixture.gitEntry}.openchamber-`));
      if (!injected && changesGitEntry && fs.lstatSync(fixture.gitEntry).isSymbolicLink()) {
        injected = true;
        execFileSync(process.execPath, ['-e', `
          const fs = require('node:fs');
          const [entry, kind, contents] = process.argv.slice(1);
          const staged = entry + '.concurrent';
          if (kind === 'file') fs.writeFileSync(staged, contents, { flag: 'wx' });
          else fs.symlinkSync(contents, staged, 'dir');
          fs.renameSync(staged, entry);
        `, fixture.gitEntry, kind, concurrentContents], { stdio: 'pipe', timeout: 10_000 });
      }
      await rename(source, destination);
    });
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow();
    } finally {
      renameSpy.mockRestore();
    }

    expect(injected).toBe(true);
    const entry = fs.lstatSync(fixture.gitEntry);
    if (kind === 'file') {
      expect(entry.isFile()).toBe(true);
      expect(fs.readFileSync(fixture.gitEntry, 'utf8')).toBe(concurrentContents);
    } else {
      expect(entry.isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(fixture.gitEntry)).toBe(concurrentContents);
    }
    expect(fs.existsSync(fixture.metadata)).toBe(true);
    expect(runGit(fixture.repo, ['rev-parse', 'feature/remove']).trim()).toBe(branchHead);
    expect(fs.readdirSync(fixture.worktree).sort()).toEqual(['.git', 'README.md']);
  });

  it.each(['file', 'symlink'])('preserves a newer .git %s created during exclusive installation', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const originalTarget = installGitDirectoryLink(fixture);
    const concurrentContents = kind === 'file' ? 'newest concurrent gitdir file\n' : `./${originalTarget}`;
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const link = fs.promises.link.bind(fs.promises);
    let injected = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
      if (!injected && destination === fixture.gitEntry) {
        injected = true;
        if (kind === 'file') fs.writeFileSync(destination, concurrentContents, { flag: 'wx' });
        else fs.symlinkSync(concurrentContents, destination, 'dir');
      }
      await link(source, destination);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow();
      expect(injected).toBe(true);
      if (kind === 'file') expect(fs.readFileSync(fixture.gitEntry, 'utf8')).toBe(concurrentContents);
      else expect(fs.readlinkSync(fixture.gitEntry)).toBe(concurrentContents);
      const claims = fs.readdirSync(fixture.worktree).filter(name => name.startsWith('.git.openchamber-'));
      expect(claims).toHaveLength(1);
      const claim = path.join(fixture.worktree, claims[0]);
      expect(fs.readlinkSync(claim)).toBe(originalTarget);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(claim));
      expect(fs.existsSync(fixture.metadata)).toBe(true);
      expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
    } finally {
      linkSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('leaves the original .git entry untouched when preparation cannot claim it', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const originalTarget = installGitDirectoryLink(fixture);
    const rename = fs.promises.rename.bind(fs.promises);
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (source === fixture.gitEntry) throw new Error('claim denied');
      await rename(source, destination);
    });
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow();
    } finally {
      renameSpy.mockRestore();
    }
    expect(fs.readlinkSync(fixture.gitEntry)).toBe(originalTarget);
    expect(fs.readdirSync(fixture.worktree).sort()).toEqual(['.git', 'README.md']);
    expect(fs.existsSync(fixture.metadata)).toBe(true);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it('retains the claimed symlink when preparation cannot install or restore .git', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const originalTarget = installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const installationError = new Error('installation denied');
    const linkSpy = vi.spyOn(fs.promises, 'link').mockRejectedValue(installationError);
    const symlinkSpy = vi.spyOn(fs.promises, 'symlink').mockRejectedValue(new Error('restoration denied'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toBe(installationError);
      expect(fs.lstatSync(fixture.gitEntry, { throwIfNoEntry: false })).toBeUndefined();
      const claims = fs.readdirSync(fixture.worktree).filter(name => name.startsWith('.git.openchamber-'));
      expect(claims).toHaveLength(1);
      const claim = path.join(fixture.worktree, claims[0]);
      expect(fs.readlinkSync(claim)).toBe(originalTarget);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(claim));
      expect(fs.existsSync(fixture.metadata)).toBe(true);
      expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
    } finally {
      linkSpy.mockRestore();
      symlinkSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it.each(['worktree', 'metadata'])('does not recreate a %s removed after the preparation claim', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const originalTarget = installGitDirectoryLink(fixture);
    const removedPath = kind === 'worktree' ? fixture.worktree : fixture.metadata;
    const rename = fs.promises.rename.bind(fs.promises);
    let claimedEntry;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      const claimsSymlink = source === fixture.gitEntry && fs.lstatSync(source).isSymbolicLink();
      await rename(source, destination);
      if (claimsSymlink) {
        claimedEntry = destination;
        fs.rmSync(removedPath, { recursive: true, force: true });
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow();
      expect(claimedEntry).toBeDefined();
      expect(fs.existsSync(removedPath)).toBe(false);
      expect(fs.lstatSync(fixture.gitEntry, { throwIfNoEntry: false })).toBeUndefined();
      if (kind === 'metadata') expect(fs.readlinkSync(claimedEntry)).toBe(originalTarget);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(claimedEntry));
      expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
    } finally {
      renameSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

});
