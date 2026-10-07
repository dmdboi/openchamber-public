import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi, beforeAll } from 'vitest';
import { registerGitServiceTestSupport } from './service-test-support.js';
import {
  removeWorktree
} from '../../../../server/lib/git/service.js';
const { runGit, canRunGit, createRemovalWorktree, installGitDirectoryLink, interceptGitFileReplacement } = registerGitServiceTestSupport({ afterEach, beforeAll, afterAll });


  it.each([false, true])('restores the exact .git symlink target after locked removal fails, absolute=%s', async (absolute) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    let linkTarget = installGitDirectoryLink(fixture, absolute);
    if (!absolute) {
      fs.unlinkSync(fixture.gitEntry);
      linkTarget = `.//${linkTarget}`;
      fs.symlinkSync(linkTarget, fixture.gitEntry, 'dir');
    }
    const branchHead = runGit(fixture.repo, ['rev-parse', 'feature/remove']).trim();
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);

    const replacementStates = [];
    const recordReplacement = () => replacementStates.push({
      kind: fs.lstatSync(fixture.gitEntry).isSymbolicLink() ? 'symlink' : 'file',
      metadataExists: fs.existsSync(fixture.metadata),
    });
    const link = fs.promises.link.bind(fs.promises);
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
      await link(source, destination);
      if (destination === fixture.gitEntry) recordReplacement();
    });
    const symlink = fs.promises.symlink.bind(fs.promises);
    const symlinkSpy = vi.spyOn(fs.promises, 'symlink').mockImplementation(async (target, destination, type) => {
      await symlink(target, destination, type);
      if (destination === fixture.gitEntry) recordReplacement();
    });
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
    } finally {
      linkSpy.mockRestore();
      symlinkSpy.mockRestore();
    }

    expect(replacementStates).toEqual([
      { kind: 'file', metadataExists: true },
      { kind: 'symlink', metadataExists: true },
    ]);
    expect(fs.readlinkSync(fixture.gitEntry)).toBe(linkTarget);
    expect(fs.readFileSync(path.join(fixture.metadata, 'commondir'), 'utf8')).toBe('../..\n');
    expect(fs.readFileSync(path.join(fixture.metadata, 'gitdir'), 'utf8').trim()).toBe(fixture.gitEntry);
    expect(fs.readFileSync(path.join(fixture.worktree, 'README.md'), 'utf8')).toBe('# Test\n');
    expect(runGit(fixture.repo, ['rev-parse', 'feature/remove']).trim()).toBe(branchHead);
    expect(fs.readdirSync(fixture.worktree).sort()).toEqual(['.git', 'README.md']);
  });

  it.each(['edited file', 'replacement file', 'symlink'])('does not overwrite a concurrent .git %s after removal fails', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    let concurrentEntry;
    let concurrentContents;
    const renameSpy = interceptGitFileReplacement(fixture.gitEntry, () => {
      const contents = fs.readFileSync(fixture.gitEntry, 'utf8');
      expect(contents).toBe(`gitdir: ${fixture.metadata}\n`);
      if (kind === 'edited file') {
        fs.writeFileSync(fixture.gitEntry, `${contents}concurrent change\n`);
      } else if (kind === 'replacement file') {
        const replacement = path.join(fixture.worktree, 'replacement');
        fs.writeFileSync(replacement, contents);
        fs.renameSync(replacement, fixture.gitEntry);
      } else {
        fs.unlinkSync(fixture.gitEntry);
        fs.symlinkSync(fixture.metadata, fixture.gitEntry, 'dir');
      }
      concurrentEntry = fs.lstatSync(fixture.gitEntry);
      concurrentContents = kind === 'symlink'
        ? fs.readlinkSync(fixture.gitEntry) : fs.readFileSync(fixture.gitEntry, 'utf8');
    });
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
    } finally {
      renameSpy.mockRestore();
    }

    expect(fs.lstatSync(fixture.gitEntry).ino).toBe(concurrentEntry.ino);
    expect(kind === 'symlink' ? fs.readlinkSync(fixture.gitEntry) : fs.readFileSync(fixture.gitEntry, 'utf8')).toBe(concurrentContents);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
    expect(fs.readdirSync(fixture.worktree).sort()).toEqual(['.git', 'README.md']);
  });

  it.each(['worktree', 'metadata', '.git'])('does not recreate a %s deleted during failed removal', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const removedPath = kind === 'worktree' ? fixture.worktree
      : kind === 'metadata' ? fixture.metadata : fixture.gitEntry;
    const renameSpy = interceptGitFileReplacement(fixture.gitEntry, () => {
      fs.rmSync(removedPath, { recursive: true, force: true });
    });
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow();
    } finally {
      renameSpy.mockRestore();
    }

    expect(fs.existsSync(removedPath)).toBe(false);
    if (kind === 'metadata') {
      expect(fs.lstatSync(fixture.gitEntry).isFile()).toBe(true);
      expect(fs.readFileSync(fixture.gitEntry, 'utf8')).toBe(`gitdir: ${fixture.metadata}\n`);
    }
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it('does not overwrite a .git edit made while rollback is being prepared', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const symlink = fs.promises.symlink.bind(fs.promises);
    const symlinkSpy = vi.spyOn(fs.promises, 'symlink').mockImplementation(async (target, destination, type) => {
      if (path.dirname(destination) === fixture.worktree) {
        fs.writeFileSync(fixture.gitEntry, 'concurrent gitdir file\n');
      }
      await symlink(target, destination, type);
    });
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
    } finally {
      symlinkSpy.mockRestore();
    }

    expect(fs.readFileSync(fixture.gitEntry, 'utf8')).toBe('concurrent gitdir file\n');
    expect(fs.readdirSync(fixture.worktree).sort()).toEqual(['.git', 'README.md']);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it.each(['edit', 'delete'])('preserves a concurrent .git %s at the rollback rename boundary', async (change) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const rename = fs.promises.rename.bind(fs.promises);
    let injected = false;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      const claimsEntry = source === fixture.gitEntry && fs.lstatSync(source).isFile();
      if (!injected && claimsEntry) {
        injected = true;
        if (change === 'edit') fs.writeFileSync(fixture.gitEntry, 'concurrent gitdir contents\n');
        else fs.unlinkSync(fixture.gitEntry);
      }
      await rename(source, destination);
    });
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
    } finally {
      renameSpy.mockRestore();
    }

    expect(injected).toBe(true);
    const entry = fs.lstatSync(fixture.gitEntry, { throwIfNoEntry: false });
    if (change === 'edit') {
      expect(entry?.isFile()).toBe(true);
      expect(fs.readFileSync(fixture.gitEntry, 'utf8')).toBe('concurrent gitdir contents\n');
    } else {
      expect(entry).toBeUndefined();
    }
    expect(fs.readdirSync(fixture.worktree).sort()).toEqual(change === 'edit' ? ['.git', 'README.md'] : ['README.md']);
    expect(fs.existsSync(fixture.metadata)).toBe(true);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it.each(['directory', 'file', 'dangling'])('restores a claimed concurrent %s symlink when hardlinks follow source symlinks', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const target = kind === 'directory' ? fixture.metadata : path.join(fixture.repo, 'concurrent.gitdir');
    const contents = `gitdir: ${fixture.metadata}\n`;
    if (kind === 'file') fs.writeFileSync(target, contents);
    const linkTarget = Buffer.from(`.//${path.relative(fixture.worktree, target)}`);
    const rename = fs.promises.rename.bind(fs.promises);
    let claimedEntry;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (source === fixture.gitEntry && fs.lstatSync(source).isFile()) {
        claimedEntry = destination;
        fs.unlinkSync(source);
        fs.symlinkSync(linkTarget, source, kind === 'directory' ? 'dir' : 'file');
      }
      await rename(source, destination);
    });
    const link = fs.promises.link.bind(fs.promises);
    // Darwin link(2) follows its source symlink; use real filesystem operations
    // with that behaviour so this recovery case runs on Linux too.
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
      await link(await fs.promises.realpath(source), destination);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
      expect(claimedEntry).toBeDefined();
      expect(fs.lstatSync(fixture.gitEntry, { throwIfNoEntry: false })?.isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(fixture.gitEntry, { encoding: 'buffer' })).toEqual(linkTarget);
      expect(fs.lstatSync(claimedEntry, { throwIfNoEntry: false })).toBeUndefined();
      expect(fs.readdirSync(fixture.worktree).sort()).toEqual(['.git', 'README.md']);
      expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
      if (kind === 'file') {
        expect(fs.statSync(target).nlink).toBe(1);
        expect(fs.readFileSync(target, 'utf8')).toBe(contents);
      }
      if (kind === 'dangling') expect(fs.existsSync(target)).toBe(false);
      else expect(runGit(fixture.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature/remove');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      renameSpy.mockRestore();
      linkSpy.mockRestore();
      warnSpy.mockRestore();
    }

  });

  it('retains a claimed concurrent symlink when symlink restoration fails', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const linkTarget = Buffer.from(`.//${path.relative(fixture.worktree, fixture.metadata)}`);
    const rename = fs.promises.rename.bind(fs.promises);
    let claimedEntry;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (source === fixture.gitEntry && fs.lstatSync(source).isFile()) {
        claimedEntry = destination;
        fs.unlinkSync(source);
        fs.symlinkSync(linkTarget, source, 'dir');
      }
      await rename(source, destination);
    });
    const restoreError = new Error('concurrent symlink restoration denied');
    const symlinkSpy = vi.spyOn(fs.promises, 'symlink').mockRejectedValue(restoreError);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
      expect(claimedEntry).toBeDefined();
      expect(fs.lstatSync(fixture.gitEntry, { throwIfNoEntry: false })).toBeUndefined();
      expect(fs.readlinkSync(claimedEntry, { encoding: 'buffer' })).toEqual(linkTarget);
      expect(fs.existsSync(fixture.metadata)).toBe(true);
      expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(claimedEntry));
    } finally {
      renameSpy.mockRestore();
      symlinkSpy.mockRestore();
      warnSpy.mockRestore();
    }

  });

  it.each(['file', 'symlink'])('retains a claimed symlink changed to a %s while its target is restored', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const linkTarget = Buffer.from(`.//${path.relative(fixture.worktree, fixture.metadata)}`);
    const rename = fs.promises.rename.bind(fs.promises);
    let claimedEntry;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (source === fixture.gitEntry && fs.lstatSync(source).isFile()) {
        claimedEntry = destination;
        fs.unlinkSync(source);
        fs.symlinkSync(linkTarget, source, 'dir');
      }
      await rename(source, destination);
    });
    const symlink = fs.promises.symlink.bind(fs.promises);
    const symlinkSpy = vi.spyOn(fs.promises, 'symlink').mockImplementation(async (target, destination, type) => {
      await symlink(target, destination, type);
      if (destination === fixture.gitEntry) {
        fs.unlinkSync(claimedEntry);
        if (kind === 'file') fs.writeFileSync(claimedEntry, 'concurrent recovery contents\n');
        else fs.symlinkSync('other-concurrent-target', claimedEntry);
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
      expect(fs.readlinkSync(fixture.gitEntry, { encoding: 'buffer' })).toEqual(linkTarget);
      expect(fs.lstatSync(claimedEntry, { throwIfNoEntry: false })).toBeDefined();
      if (kind === 'file') expect(fs.readFileSync(claimedEntry, 'utf8')).toBe('concurrent recovery contents\n');
      else expect(fs.readlinkSync(claimedEntry)).toBe('other-concurrent-target');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(claimedEntry));
    } finally {
      renameSpy.mockRestore();
      symlinkSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it.each(['file', 'symlink'])('retains a claimed concurrent .git %s when a newer entry prevents putting it back', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const rename = fs.promises.rename.bind(fs.promises);
    let claimedEntry;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      const claimsTemporaryEntry = source === fixture.gitEntry && fs.lstatSync(source).isFile();
      if (claimsTemporaryEntry) {
        claimedEntry = destination;
        if (kind === 'file') {
          fs.writeFileSync(source, 'older concurrent gitdir file\n');
        } else {
          fs.unlinkSync(source);
          fs.symlinkSync(fixture.metadata, source, 'dir');
        }
      }
      await rename(source, destination);
      if (claimsTemporaryEntry) fs.writeFileSync(source, 'newest concurrent gitdir file\n');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
      expect(claimedEntry).toBeDefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(claimedEntry));
    } finally {
      renameSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(fs.readFileSync(fixture.gitEntry, 'utf8')).toBe('newest concurrent gitdir file\n');
    if (kind === 'file') expect(fs.readFileSync(claimedEntry, 'utf8')).toBe('older concurrent gitdir file\n');
    else expect(fs.readlinkSync(claimedEntry)).toBe(fixture.metadata);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it('retains a claimed concurrent directory at the logged recovery path', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const rename = fs.promises.rename.bind(fs.promises);
    let claimedEntry;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (source === fixture.gitEntry && fs.lstatSync(source).isFile()) {
        claimedEntry = destination;
        fs.unlinkSync(source);
        fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, 'canary'), 'concurrent directory contents\n');
      }
      await rename(source, destination);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
      expect(claimedEntry).toBeDefined();
      expect(fs.lstatSync(fixture.gitEntry, { throwIfNoEntry: false })).toBeUndefined();
      expect(fs.readFileSync(path.join(claimedEntry, 'canary'), 'utf8')).toBe('concurrent directory contents\n');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(claimedEntry));
    } finally {
      renameSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(fs.existsSync(fixture.metadata)).toBe(true);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it.each(['worktree', 'metadata'])('does not recreate a %s removed after the rollback claim', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const rename = fs.promises.rename.bind(fs.promises);
    const removedPath = kind === 'worktree' ? fixture.worktree : fixture.metadata;
    let claimedEntry;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      const claimsTemporaryEntry = source === fixture.gitEntry && fs.lstatSync(source).isFile();
      await rename(source, destination);
      if (claimsTemporaryEntry) {
        claimedEntry = destination;
        fs.rmSync(removedPath, { recursive: true, force: true });
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
    } finally {
      renameSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(claimedEntry).toBeDefined();
    expect(fs.existsSync(removedPath)).toBe(false);
    expect(fs.existsSync(fixture.gitEntry)).toBe(false);
    if (kind === 'metadata') expect(fs.readFileSync(claimedEntry, 'utf8')).toBe(`gitdir: ${fixture.metadata}\n`);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it('preserves the native removal error and gitdir file when symlink restoration fails', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const restoreError = new Error('symlink restoration denied');
    const symlinkSpy = vi.spyOn(fs.promises, 'symlink').mockRejectedValue(restoreError);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to restore worktree .git symlink after removal failed:',
        restoreError,
      );
    } finally {
      symlinkSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(fs.lstatSync(fixture.gitEntry).isFile()).toBe(true);
    expect(fs.readFileSync(fixture.gitEntry, 'utf8')).toBe(`gitdir: ${fixture.metadata}\n`);
    expect(fs.readdirSync(fixture.worktree).sort()).toEqual(['.git', 'README.md']);
    expect(runGit(fixture.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature/remove');
  });

  it('restores the original .git symlink when exclusive installation fails', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const linkTarget = installGitDirectoryLink(fixture);
    const link = fs.promises.link.bind(fs.promises);
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
      if (destination === fixture.gitEntry) throw new Error('replacement denied');
      await link(source, destination);
    });
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow('replacement denied');
    } finally {
      linkSpy.mockRestore();
    }

    expect(fs.readlinkSync(fixture.gitEntry)).toBe(linkTarget);
    expect(fs.existsSync(fixture.metadata)).toBe(true);
    expect(fs.readdirSync(fixture.worktree).sort()).toEqual(['.git', 'README.md']);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });
