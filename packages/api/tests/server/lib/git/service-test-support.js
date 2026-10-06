import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import simpleGit from 'simple-git';
import { vi } from 'vitest';

/** Register isolated Git fixtures and environment cleanup for one test file. */
export function registerGitServiceTestSupport({ afterEach, beforeAll, afterAll }) {
  const tempDirs = [];
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-service-config-'));
  const emptyGlobalGitConfig = path.join(configDirectory, 'git-config');
  fs.writeFileSync(emptyGlobalGitConfig, '');
  let savedGitConfigGlobal;

  const createTempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-service-'));
    tempDirs.push(dir);
    return dir;
  };

  const runGit = (cwd, args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.platform === 'win32'
        ? { ...process.env, MSYS: [process.env.MSYS, 'noglob'].filter(Boolean).join(' ') }
        : process.env,
    });

  const createRepositoryWithRemote = ({ remoteName = 'origin', defaultBranch = 'react' } = {}) => {
    const remote = createTempDir();
    const repository = createTempDir();
    runGit(remote, ['init', '--bare', `--initial-branch=${defaultBranch}`]);
    runGit(repository, ['init', '-b', 'next']);
    runGit(repository, ['config', 'user.email', 'test@example.com']);
    runGit(repository, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n');
    runGit(repository, ['add', 'README.md']);
    runGit(repository, ['commit', '-m', 'init']);
    runGit(repository, ['remote', 'add', remoteName, remote]);
    runGit(repository, ['push', remoteName, `HEAD:${defaultBranch}`]);
    runGit(repository, ['fetch', remoteName]);
    runGit(repository, ['remote', 'set-head', remoteName, '--auto']);
    return { remote, repository };
  };

  const canRunGit = () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-check-'));
    try {
      execFileSync('git', ['--version'], { cwd, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  };

  const createTempRepo = async () => {
    const tmpDir = createTempDir();
    const git = simpleGit(tmpDir);
    await git.init();
    await git.addConfig('user.name', 'Test User', false, 'local');
    await git.addConfig('user.email', 'test@example.com', false, 'local');
    await git.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    return { tmpDir, git };
  };

  const createRemovalWorktree = () => {
    const repo = fs.realpathSync(createTempDir());
    const worktree = path.join(fs.realpathSync(createTempDir()), 'linked');
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'init']);
    runGit(repo, ['worktree', 'add', '-b', 'feature/remove', worktree]);
    const gitEntry = path.join(worktree, '.git');
    const metadata = fs.realpathSync(fs.readFileSync(gitEntry, 'utf8').slice('gitdir: '.length).trim());
    return { repo, worktree, gitEntry, metadata };
  };

  const installGitDirectoryLink = ({ worktree, gitEntry, metadata }, absolute = false) => {
    const linkTarget = absolute ? metadata : path.relative(worktree, metadata);
    fs.unlinkSync(gitEntry);
    fs.symlinkSync(linkTarget, gitEntry, 'dir');
    return linkTarget;
  };

  const interceptGitFileReplacement = (gitEntry, afterReplacement) => {
    const link = fs.promises.link.bind(fs.promises);
    let intercepted = false;
    return vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
      await link(source, destination);
      if (destination === gitEntry && !intercepted) {
        intercepted = true;
        afterReplacement();
      }
    });
  };

  beforeAll(() => {
    savedGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = emptyGlobalGitConfig;
  });
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  afterAll(() => {
    if (savedGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGitConfigGlobal;
    fs.rmSync(configDirectory, { recursive: true, force: true });
  });

  return {
    createTempDir, runGit, createRepositoryWithRemote, canRunGit, createTempRepo,
    createRemovalWorktree, installGitDirectoryLink, interceptGitFileReplacement,
  };
}
