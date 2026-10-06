// Shared Git runtime and repository-context primitives.
//
// This module owns the pieces every Git call needs before it can touch a
// repository: the located Git binary, the simple-git instance and its
// scrubbed environment, directory and Git path normalization, the
// process-local index-mutation queues, repository file-path validation, and
// repository root/context resolution. `service.js` composes the operation
// services from these primitives; this module never imports back into it.
//
// The process-local state here (the resolved Git binary and the index
// mutation queues) is owned exactly once, in this module.

import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { stripAppImageLauncherEnv } from '../inherited-env.js';
import { normalizeGitOutputPath } from './output-path.js';

const fsp = fs.promises;
const execFileAsync = promisify(execFile);
const gpgconfCandidates = ['gpgconf', '/opt/homebrew/bin/gpgconf', '/usr/local/bin/gpgconf'];
let resolvedGitBinary = null;
const SIMPLE_GIT_SAFE_BINARY_PATTERN = /^([a-z]:)?([a-z0-9/.\\_~-]+)$/i;
const SIMPLE_GIT_UNSAFE_BINARY_WARNING = 'Invalid value supplied for custom binary, restricted characters must be removed';
const gitIndexMutationQueues = new Map();

const isExecutableFile = (candidate) => {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    return false;
  }
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      const ext = path.extname(candidate).toLowerCase();
      return ext.length === 0 || ext === '.exe' || ext === '.cmd' || ext === '.bat' || ext === '.com';
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const normalizeGitExecutableCandidate = (candidate) => {
  if (typeof candidate !== 'string') {
    return null;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }

  const ext = path.extname(trimmed).toLowerCase();
  if (ext === '.cmd' || ext === '.bat' || ext === '.com') {
    const exeCandidate = trimmed.slice(0, -ext.length) + '.exe';
    if (isExecutableFile(exeCandidate)) {
      return exeCandidate;
    }
  }

  return trimmed;
};

const isSafeSimpleGitBinary = (candidate) => (
  typeof candidate === 'string' && SIMPLE_GIT_SAFE_BINARY_PATTERN.test(candidate)
);

const createSimpleGit = (options) => {
  if (!options?.unsafe?.allowUnsafeCustomBinary) {
    return simpleGit(options);
  }

  const originalWarn = console.warn;
  console.warn = (...args) => {
    if (String(args[0] || '').includes(SIMPLE_GIT_UNSAFE_BINARY_WARNING)) {
      return;
    }
    originalWarn(...args);
  };

  try {
    return simpleGit(options);
  } finally {
    console.warn = originalWarn;
  }
};

const listPathExecutableCandidates = (binaryName) => {
  const currentPath = process.env.PATH || '';
  const seen = new Set();
  const matches = [];
  for (const segment of currentPath.split(path.delimiter)) {
    const dir = typeof segment === 'string' ? segment.trim() : '';
    if (!dir || seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    matches.push(path.join(dir, binaryName));
  }
  return matches;
};

const listWindowsGitInstallCandidates = () => {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LocalAppData,
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);

  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, 'Git', 'cmd', 'git.exe'));
    candidates.push(path.join(root, 'Git', 'bin', 'git.exe'));
    candidates.push(path.join(root, 'Git', 'mingw64', 'bin', 'git.exe'));
    candidates.push(path.join(root, 'Programs', 'Git', 'cmd', 'git.exe'));
    candidates.push(path.join(root, 'Programs', 'Git', 'bin', 'git.exe'));
  }
  return candidates;
};

const resolveGitBinary = () => {
  if (process.platform !== 'win32') {
    return 'git';
  }
  if (resolvedGitBinary) {
    return resolvedGitBinary;
  }

  const explicit = [process.env.GIT_BINARY, process.env.OPENCHAMBER_GIT_BINARY]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  for (const candidate of explicit) {
    const normalized = normalizeGitExecutableCandidate(candidate);
    if (isExecutableFile(normalized)) {
      resolvedGitBinary = normalized;
      return resolvedGitBinary;
    }
  }

  const pathDiscovered = [
    ...listPathExecutableCandidates('git.exe'),
    ...listPathExecutableCandidates('git'),
  ]
    .map(normalizeGitExecutableCandidate)
    .filter(Boolean)
    .filter((candidate) => isExecutableFile(candidate));
  if (pathDiscovered.length > 0) {
    resolvedGitBinary = 'git';
    return resolvedGitBinary;
  }

  const discovered = [
    ...listWindowsGitInstallCandidates(),
  ]
    .map(normalizeGitExecutableCandidate)
    .filter(Boolean)
    .filter((candidate) => isExecutableFile(candidate));

  const preferredExe = discovered.find((candidate) => isSafeSimpleGitBinary(candidate) && candidate.toLowerCase().endsWith('.exe'))
    || discovered.find((candidate) => candidate.toLowerCase().endsWith('.exe'));
  resolvedGitBinary = preferredExe || discovered[0] || 'git.exe';
  return resolvedGitBinary;
};

export const getGitBinary = () => resolveGitBinary();

const isSocketPath = async (candidate) => {
  if (!candidate || typeof candidate !== 'string') {
    return false;
  }
  try {
    const stat = await fsp.stat(candidate);
    return typeof stat.isSocket === 'function' && stat.isSocket();
  } catch {
    return false;
  }
};

const resolveSshAuthSock = async () => {
  const existing = (process.env.SSH_AUTH_SOCK || '').trim();
  if (existing) {
    return existing;
  }

  if (process.platform === 'win32') {
    return null;
  }

  const gpgSock = path.join(os.homedir(), '.gnupg', 'S.gpg-agent.ssh');
  if (await isSocketPath(gpgSock)) {
    return gpgSock;
  }

  const runGpgconf = async (args) => {
    for (const candidate of gpgconfCandidates) {
      try {
        const { stdout } = await execFileAsync(candidate, args);
        return String(stdout || '');
      } catch {
        continue;
      }
    }
    return '';
  };

  const candidate = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
  if (candidate && await isSocketPath(candidate)) {
    return candidate;
  }

  if (candidate) {
    await runGpgconf(['--launch', 'gpg-agent']);
    const retried = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
    if (retried && await isSocketPath(retried)) {
      return retried;
    }
  }

  return null;
};

export const buildGitEnv = async () => {
  // Git runs the user's hooks, so they must not see what the AppImage launcher
  // added to LD_LIBRARY_PATH and friends (#4177).
  const env = stripAppImageLauncherEnv({ ...process.env });
  if (process.platform === 'win32') {
    // Node already passes an argument array. MSYS globbing corrupts Git refs
    // such as HEAD^{commit} and branch@{upstream} before Git sees them.
    env.MSYS = [env.MSYS, 'noglob'].filter(Boolean).join(' ');
  }
  if (!env.SSH_AUTH_SOCK || !env.SSH_AUTH_SOCK.trim()) {
    const resolved = await resolveSshAuthSock();
    if (resolved) {
      env.SSH_AUTH_SOCK = resolved;
    }
  }
  // The server has no terminal a user could answer. Without this, Git asks
  // for a username or password on its (hidden, on Windows) console and waits
  // forever; credential helpers and GUI prompts still run before this point.
  if (env.GIT_TERMINAL_PROMPT === undefined) {
    env.GIT_TERMINAL_PROMPT = '0';
  }
  return env;
};

// simple-git refuses every command whose env holds a variable that runs a
// program (EDITOR, PAGER, GIT_SSH_COMMAND, GIT_ASKPASS, ...) unless its unsafe
// category is enabled, and the same categories also guard -c and other
// arguments, so enabling them would weaken argument protection. A variable the
// server's own environment passes through unchanged is what git would inherit
// without an env anyway, so it goes on the prototype: simple-git's check copies
// only own keys, while child_process.spawn passes inherited keys to the child.
// Whatever OpenChamber sets or changes stays an own key and is still checked.
const toSimpleGitEnv = (env) => {
  const passedThrough = {};
  const changed = {};
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === value) {
      passedThrough[key] = value;
    } else {
      changed[key] = value;
    }
  }
  return Object.assign(Object.create(passedThrough), changed);
};

// Transport configuration is owned by repository bindings and the credential
// broker, so no caller needs simple-git's unsafe SSH-command or
// credential-helper escapes any more.
export const createGit = async (directory, { stallTimeoutMs = 0 } = {}) => {
  const env = await buildGitEnv();
  const spawnOptions = { windowsHide: true };
  // simple-git's block timeout kills the process once it has produced no
  // output for this long. Opt-in per caller: a background read must never hold
  // a limiter slot forever, while a silent long push or fetch must not be cut.
  const timeout = stallTimeoutMs > 0 ? { block: stallTimeoutMs } : undefined;
  const binary = getGitBinary();
  const hasCustomBinary = typeof binary === 'string' && binary.trim() && binary !== 'git' && binary !== 'git.exe';
  const unsafe = hasCustomBinary ? { allowUnsafeCustomBinary: true } : undefined;
  // Always pin simple-git to an explicit working directory. Omitting baseDir
  // makes simple-git use process.cwd(), which breaks when the OpenChamber
  // server was launched from a neutral directory (e.g. $HOME) and the opened
  // project lives elsewhere — session/project discovery then sees spurious
  // "not a git repository" errors and can abort enumeration.
  const baseDir = normalizeDirectoryPath(directory);
  if (typeof baseDir !== 'string' || !baseDir.trim()) {
    throw new Error('Git directory is required');
  }
  // simple-git ignores an `env` constructor option; only .env() reaches git.
  return createSimpleGit({
    baseDir,
    spawnOptions,
    binary,
    unsafe,
    ...(timeout ? { timeout } : {}),
  }).env(toSimpleGitEnv(env));
};

// Global config reads do not need a repository; use the home directory as a
// stable baseDir so we never accidentally inherit process.cwd().
export const createGitForGlobalConfig = async () => createGit(os.homedir());

export const normalizeDirectoryPath = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed === '~') {
    return os.homedir();
  }

  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  return trimmed;
};

export const normalizePath = (value) => {
  const normalized = normalizeDirectoryPath(value);
  if (typeof normalized !== 'string') {
    return normalized;
  }
  return normalized.replace(/\\/g, '/');
};

const getGitIndexMutationQueueKey = (directory) => {
  const normalized = normalizeDirectoryPath(directory);
  if (!normalized) {
    return '';
  }
  return path.resolve(normalized);
};

export const withGitIndexMutationQueue = async (directory, task) => {
  let key = getGitIndexMutationQueueKey(directory);
  try {
    const directoryPath = normalizeDirectoryPath(directory);
    if (directoryPath) {
      const git = await createGit(directoryPath);
      key = await resolveGitRepositoryRoot(directoryPath, git);
    }
  } catch {
    // Fall back to the normalized directory key when the repo root is unavailable.
  }
  if (!key) {
    return task();
  }

  const previous = gitIndexMutationQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  const tail = current.catch(() => {});
  gitIndexMutationQueues.set(key, tail);

  try {
    return await current;
  } finally {
    if (gitIndexMutationQueues.get(key) === tail) {
      gitIndexMutationQueues.delete(key);
    }
  }
};

export const normalizeFilePathList = (paths) => Array.from(new Set(
  (Array.isArray(paths) ? paths : [paths])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
));

export const validateRepositoryFilePaths = (directoryPath, filePaths) => {
  const repoRoot = path.resolve(directoryPath);

  for (const filePath of filePaths) {
    const absoluteTarget = path.resolve(repoRoot, filePath);
    if (!absoluteTarget.startsWith(repoRoot + path.sep) && absoluteTarget !== repoRoot) {
      throw new Error(`Path is outside repository: ${filePath}`);
    }
  }
};

export const toGitPath = (value) => value.replace(/\\/g, '/');

export const isInsideOrSameDirectory = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export const resolveGitRepositoryRoot = async (directoryPath, git) => {
  const topLevel = await git.raw(['rev-parse', '--show-toplevel']);
  const normalizedTopLevel = normalizeGitOutputPath(topLevel.trim());
  return path.isAbsolute(normalizedTopLevel)
    ? path.resolve(normalizedTopLevel)
    : path.resolve(directoryPath, normalizedTopLevel);
};

export const createRepositoryGitContext = async (directory, gitOptions = {}) => {
  const directoryPath = normalizeDirectoryPath(directory);
  if (typeof directoryPath !== 'string' || !directoryPath.trim()) {
    throw new Error('Git directory is required');
  }
  const directoryGit = await createGit(directoryPath, gitOptions);
  const repoRoot = await resolveGitRepositoryRoot(directoryPath, directoryGit);
  const git = path.resolve(directoryPath) === repoRoot ? directoryGit : await createGit(repoRoot, gitOptions);
  return { directoryPath, directoryGit, repoRoot, git };
};

/**
 * Absolute repository root for a directory anywhere inside it. Callers that key
 * persisted data by repository need this so two directories in the same
 * repository do not address different records.
 */
export async function getRepositoryRoot(directory) {
  const { repoRoot } = await createRepositoryGitContext(directory);
  return repoRoot;
}
