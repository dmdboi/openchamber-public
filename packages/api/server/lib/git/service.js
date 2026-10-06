import simpleGit from 'simple-git';
import { createStatusService } from './services/status.js';
import { createDiffService } from './services/diff.js';
import { createFileService } from './services/files.js';
import { createWorktreeService } from './services/worktrees.js';
import { createWorktreeStateService } from './services/worktree-state.js';
import { createWorktreeRemovalService } from './services/worktree-removal.js';
import { createBranchesService } from './services/branches.js';
import { createBranchQueriesService } from './services/branch-queries.js';
import { createIdentityService } from './services/identity.js';
import { createRangeDiffService } from './services/range-diff.js';
import { createHistoryService } from './services/history.js';
import { createIntegrateService } from './services/integrate.js';
import { createMergeService } from './services/merge.js';
import { stripAppImageLauncherEnv } from '../inherited-env.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import crypto from 'node:crypto';
import { fingerprintRemoteUrl } from '../source-control/url-redaction.js';
import { readWorktreeDirectorySetting } from '../opencode/shared.js';
import { normalizeGitOutputPath } from './output-path.js';
import { unsupportedRepositoryRootReason } from './repository-root.js';
import { randomUUID } from 'crypto';

const fsp = fs.promises;
const GIT_PROBE_TIMEOUT_MS = 30_000;
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const gpgconfCandidates = ['gpgconf', '/opt/homebrew/bin/gpgconf', '/usr/local/bin/gpgconf'];
let resolvedGitBinary = null;
const worktreeBootstrapState = new Map();
const activeWorktreeBootstrapTasks = new Map();
const remoteExistenceCache = new Map();
const SIMPLE_GIT_SAFE_BINARY_PATTERN = /^([a-z]:)?([a-z0-9/.\\_~-]+)$/i;
const SIMPLE_GIT_UNSAFE_BINARY_WARNING = 'Invalid value supplied for custom binary, restricted characters must be removed';
const REMOTE_EXISTENCE_CACHE_TTL_MS = 30_000;
const gitIndexMutationQueues = new Map();
const remoteProvisioningQueues = new Map();

const WORKTREE_BOOTSTRAP_PENDING = 'pending';
const WORKTREE_BOOTSTRAP_READY = 'ready';
const WORKTREE_BOOTSTRAP_FAILED = 'failed';
const WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED = 'directory-created';
const WORKTREE_BOOTSTRAP_PHASE_GIT_READY = 'git-ready';
const WORKTREE_BOOTSTRAP_PHASE_SETUP_READY = 'setup-ready';
const WORKTREE_BOOTSTRAP_RECOVERY_ERROR = 'Worktree bootstrap completion is unknown. Inspect the checkout and repair setup before use.';
const GIT_NULL_REF = '0'.repeat(40);
const WORKTREE_INDEX_LOCK_RETRY_DELAY_MS = 250;
const WORKTREE_INDEX_LOCK_STALE_DELAY_MS = 750;

const toBootstrapStateKey = (directory) => {
  const normalized = normalizeDirectoryPath(directory);
  if (!normalized) {
    return '';
  }
  return path.resolve(normalized);
};

const toCanonicalBootstrapStateKey = async (directory) => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return '';
  }
  const realPath = await fsp.realpath(key).catch(() => key);
  const normalized = path.normalize(realPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const createWorktreeBootstrapState = (status, phase, error = null, hydration, errorCode) => {
  const safeError = typeof error === 'string'
    ? error.trim().replace(/[\0\r\n]+/g, ' ').replace(/\s+/g, ' ').slice(0, 4096)
    : '';
  const state = {
    status,
    phase,
    error: safeError || null,
    updatedAt: Date.now(),
  };
  if (hydration) state.hydration = hydration;
  if (errorCode) state.errorCode = errorCode;
  return state;
};

const setWorktreeBootstrapState = async (directory, status, phase, error = null, hydration, errorCode, bootstrapStore) => {
  const key = await toCanonicalBootstrapStateKey(directory);
  if (!key) {
    return null;
  }
  let state = createWorktreeBootstrapState(status, phase, error, hydration, errorCode);
  worktreeBootstrapState.set(key, state);
  if (bootstrapStore) {
    try {
      state = await bootstrapStore.write(key, state);
      worktreeBootstrapState.set(key, state);
    } catch (cause) {
      const blocker = createWorktreeBootstrapState(
        WORKTREE_BOOTSTRAP_FAILED,
        phase === WORKTREE_BOOTSTRAP_PHASE_SETUP_READY ? WORKTREE_BOOTSTRAP_PHASE_GIT_READY : phase,
        WORKTREE_BOOTSTRAP_RECOVERY_ERROR,
        undefined,
        'UNKNOWN',
      );
      worktreeBootstrapState.set(key, blocker);
      throw Object.assign(new Error(WORKTREE_BOOTSTRAP_RECOVERY_ERROR, { cause }), {
        code: 'WORKTREE_BOOTSTRAP_PERSISTENCE_FAILED',
        bootstrapStatus: blocker,
      });
    }
  }
  return state;
};

const clearWorktreeBootstrapState = async (directory, bootstrapStore) => {
  const key = await toCanonicalBootstrapStateKey(directory);
  if (!key) {
    return;
  }
  if (bootstrapStore) await bootstrapStore.remove(key);
  worktreeBootstrapState.delete(key);
};

const trackWorktreeBootstrapTask = (directory, task) => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return task;
  }

  let tasks = activeWorktreeBootstrapTasks.get(key);
  if (!tasks) {
    tasks = new Set();
    activeWorktreeBootstrapTasks.set(key, tasks);
  }
  tasks.add(task);
  const clearTask = () => {
    tasks.delete(task);
    if (tasks.size === 0 && activeWorktreeBootstrapTasks.get(key) === tasks) {
      activeWorktreeBootstrapTasks.delete(key);
    }
  };
  void task.then(clearTask, clearTask);
  return task;
};

const waitForActiveWorktreeBootstrap = async (directory) => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return;
  }

  while (true) {
    let tasks = activeWorktreeBootstrapTasks.get(key);
    if (!tasks) {
      const canonicalKey = await canonicalPath(key);
      for (const [trackedKey, trackedTasks] of activeWorktreeBootstrapTasks) {
        if (await canonicalPath(trackedKey) === canonicalKey) {
          tasks = trackedTasks;
          break;
        }
      }
    }
    if (!tasks) {
      return;
    }
    await Promise.allSettled([...tasks]);
  }
};

const hasActiveWorktreeBootstrap = async (directory) => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return false;
  }
  if (activeWorktreeBootstrapTasks.has(key)) {
    return true;
  }
  const canonicalKey = await toCanonicalBootstrapStateKey(key);
  for (const trackedKey of activeWorktreeBootstrapTasks.keys()) {
    if (await toCanonicalBootstrapStateKey(trackedKey) === canonicalKey) {
      return true;
    }
  }
  return false;
};

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

const getGitBinary = () => resolveGitBinary();

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

const buildGitEnv = async () => {
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
const createGit = async (directory, { stallTimeoutMs = 0 } = {}) => {
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
const createGitForGlobalConfig = async () => createGit(os.homedir());

const normalizeDirectoryPath = (value) => {
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

const normalizePath = (value) => {
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

const withGitIndexMutationQueue = async (directory, task) => {
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

const normalizeFilePathList = (paths) => Array.from(new Set(
  (Array.isArray(paths) ? paths : [paths])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
));

const validateRepositoryFilePaths = (directoryPath, filePaths) => {
  const repoRoot = path.resolve(directoryPath);

  for (const filePath of filePaths) {
    const absoluteTarget = path.resolve(repoRoot, filePath);
    if (!absoluteTarget.startsWith(repoRoot + path.sep) && absoluteTarget !== repoRoot) {
      throw new Error(`Path is outside repository: ${filePath}`);
    }
  }
};

const toGitPath = (value) => value.replace(/\\/g, '/');

const isInsideOrSameDirectory = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const resolveGitRepositoryRoot = async (directoryPath, git) => {
  const topLevel = await git.raw(['rev-parse', '--show-toplevel']);
  const normalizedTopLevel = normalizeGitOutputPath(topLevel.trim());
  return path.isAbsolute(normalizedTopLevel)
    ? path.resolve(normalizedTopLevel)
    : path.resolve(directoryPath, normalizedTopLevel);
};

const createRepositoryGitContext = async (directory, gitOptions = {}) => {
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

const resolveGitInternalPath = async (repoRoot, git, gitPath) => {
  const resolved = await git.raw(['rev-parse', '--git-path', gitPath]);
  return path.resolve(repoRoot, normalizeGitOutputPath(resolved.trim()));
};

const GITLINK_MODE = '160000';

// Paths from `git status` can stop resolving: the file was removed after the
// listing, or the entry is a nested repository git reports as `dir/`. Callers
// tell these apart by `code`, and diff routes send the code to clients as is.
const GIT_PATH_NOT_FOUND = 'path_not_found';
const GIT_PATH_IS_NESTED_REPOSITORY = 'nested_repository';
const GIT_PATH_IS_UNTRACKED_DIRECTORY = 'untracked_directory';

const GIT_PATH_ERROR_MESSAGES = {
  [GIT_PATH_IS_NESTED_REPOSITORY]: (filePath) => `Path is a separate Git repository: ${filePath}`,
  [GIT_PATH_IS_UNTRACKED_DIRECTORY]: (filePath) => `Path is a directory of untracked files: ${filePath}`,
  [GIT_PATH_NOT_FOUND]: (filePath) => `Path not found in working tree, index, or HEAD: ${filePath}`,
};

const createGitPathError = (code, filePath) => Object.assign(new Error(GIT_PATH_ERROR_MESSAGES[code](filePath)), { code });

// Mode of the exact entry at `repoPath`, or null. `cat-file -e` cannot answer
// this: a gitlink's commit lives in the submodule's object store, so git exits 1
// without stderr, which simple-git reports as success.
const readGitEntryMode = async (repoRoot, args, repoPath) => {
  const result = await runGitCommand(repoRoot, args);
  if (!result.success) return null;
  for (const record of result.stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab !== -1 && record.slice(tab + 1) === repoPath) {
      return record.slice(0, record.indexOf(' '));
    }
  }
  return null;
};

const resolveGitFileContext = async (directoryPath, git, filePath, repoRootOverride = null) => {
  const repoRoot = repoRootOverride || await resolveGitRepositoryRoot(directoryPath, git);
  const candidates = Array.from(new Set([
    path.resolve(repoRoot, filePath),
    path.resolve(directoryPath, filePath),
  ]));
  let nestedRepository = false;
  let untrackedDirectory = false;

  for (const absolutePath of candidates) {
    if (!isInsideOrSameDirectory(repoRoot, absolutePath)) {
      continue;
    }

    const repoPath = toGitPath(path.relative(repoRoot, absolutePath));
    const worktreeEntry = await fsp.lstat(absolutePath).catch(() => null);
    const isSymbolicLink = worktreeEntry?.isSymbolicLink() ?? false;
    const existsInWorktree = worktreeEntry?.isFile() || isSymbolicLink;
    const indexMode = await readGitEntryMode(repoRoot, ['ls-files', '--stage', '-z', '--', `:(literal)${repoPath}`], repoPath);
    const headMode = await readGitEntryMode(repoRoot, ['ls-tree', '-z', 'HEAD', '--', repoPath], repoPath);

    if (existsInWorktree || indexMode || headMode) {
      return {
        absolutePath,
        repoPath,
        repoRoot,
        isSymbolicLink,
        isSubmodule: indexMode === GITLINK_MODE || headMode === GITLINK_MODE,
      };
    }

    if (worktreeEntry?.isDirectory()) {
      if (await fsp.lstat(path.join(absolutePath, '.git')).then(() => true, () => false)) {
        nestedRepository = true;
      } else {
        // Status lists a directory whose untracked files were not expanded
        // (see readStatus) as `dir/`; there is no single patch for it.
        untrackedDirectory = true;
      }
    }
  }

  if (nestedRepository) throw createGitPathError(GIT_PATH_IS_NESTED_REPOSITORY, filePath);
  if (untrackedDirectory) throw createGitPathError(GIT_PATH_IS_UNTRACKED_DIRECTORY, filePath);
  throw createGitPathError(GIT_PATH_NOT_FOUND, filePath);
};

/**
 * What a submodule entry records, since its text patch cannot show everything:
 * with only untracked files inside, `git status` marks it modified while
 * `git diff` prints nothing.
 */
const readSubmoduleState = async (repoRoot, fileContext) => {
  const status = await runGitCommand(repoRoot, ['status', '--porcelain=v2', '-z', '--', `:(literal)${fileContext.repoPath}`]);
  if (!status.success) {
    throw new Error(status.message || 'Failed to read submodule status');
  }
  // Changed: "1 XY S<c><m><u> mH mI mW hH hI path" ("2" adds rename fields
  // after hI). Unmerged: "u XY S<c><m><u> m1 m2 m3 mW h1 h2 h3 path", with no
  // stage-0 index entry. A clean submodule has no record, so HEAD and the index
  // record the same commit.
  const record = status.stdout.split('\0').find((entry) => /^[12u] /.test(entry))?.split(' ');
  const hasConflict = record?.[0] === 'u';
  const readHead = async () => (await runGitCommand(repoRoot, ['rev-parse', '--verify', '--quiet', `HEAD:${fileContext.repoPath}`])).stdout.trim();
  const head = record && !hasConflict ? record[6] : await readHead();
  const index = hasConflict ? '' : (record ? record[7] : head);
  const flags = record ? record[2] : 'S...';
  // Without its own `.git`, rev-parse would answer for the parent repository.
  const initialized = await fsp.lstat(path.join(fileContext.absolutePath, '.git')).then(() => true, () => false);
  const worktree = initialized ? await runGitCommand(fileContext.absolutePath, ['rev-parse', '--verify', 'HEAD']) : null;
  const commitOrNull = (value) => (value && !/^0+$/.test(value) ? value : null);

  return {
    headCommit: commitOrNull(head),
    indexCommit: commitOrNull(index),
    worktreeCommit: worktree?.success ? worktree.stdout.trim() : null,
    hasTrackedChanges: flags[2] === 'M',
    hasUntrackedFiles: flags[3] === 'U',
    hasConflict,
  };
};

const cleanBranchName = (branch) => {
  if (!branch) {
    return branch;
  }
  if (branch.startsWith('refs/heads/')) {
    return branch.substring('refs/heads/'.length);
  }
  if (branch.startsWith('heads/')) {
    return branch.substring('heads/'.length);
  }
  if (branch.startsWith('refs/')) {
    return branch.substring('refs/'.length);
  }
  return branch;
};

const OPENCODE_ADJECTIVES = [
  'brave',
  'calm',
  'clever',
  'cosmic',
  'crisp',
  'curious',
  'eager',
  'gentle',
  'glowing',
  'happy',
  'hidden',
  'jolly',
  'kind',
  'lucky',
  'mighty',
  'misty',
  'neon',
  'nimble',
  'playful',
  'proud',
  'quick',
  'quiet',
  'shiny',
  'silent',
  'stellar',
  'sunny',
  'swift',
  'tidy',
  'witty',
];

const OPENCODE_NOUNS = [
  'cabin',
  'cactus',
  'canyon',
  'circuit',
  'comet',
  'eagle',
  'engine',
  'falcon',
  'forest',
  'garden',
  'harbor',
  'island',
  'knight',
  'lagoon',
  'meadow',
  'moon',
  'mountain',
  'nebula',
  'orchid',
  'otter',
  'panda',
  'pixel',
  'planet',
  'river',
  'rocket',
  'sailor',
  'squid',
  'star',
  'tiger',
  'wizard',
  'wolf',
];

const OPENCODE_WORKTREE_ATTEMPTS = 26;

const getOpenCodeDataPath = () => {
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgDataHome, 'opencode');
};

const pickRandom = (values) => values[Math.floor(Math.random() * values.length)];

const generateOpenCodeRandomName = () => `${pickRandom(OPENCODE_ADJECTIVES)}-${pickRandom(OPENCODE_NOUNS)}`;

const slugWorktreeName = (value) => {
  return String(value || '')
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '')
    .split('/').join('-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 80);
};

const parseWorktreePorcelain = (raw) => {
  const lines = String(raw || '').split('\n').map((line) => line.trim());
  const entries = [];
  let current = null;

  for (const line of lines) {
    if (!line) {
      if (current?.worktree) {
        entries.push(current);
      }
      current = null;
      continue;
    }

    if (line.startsWith('worktree ')) {
      if (current?.worktree) {
        entries.push(current);
      }
      current = { worktree: normalizeGitOutputPath(line.substring('worktree '.length).trim()) };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith('HEAD ')) {
      current.head = line.substring('HEAD '.length).trim();
      continue;
    }

    if (line.startsWith('branch ')) {
      const branchRef = line.substring('branch '.length).trim();
      current.branchRef = branchRef;
      current.branch = cleanBranchName(branchRef);
      continue;
    }

    // git marks a worktree whose directory is gone (deleted outside git) as
    // prunable; it stays registered until `git worktree prune`. The sidebar
    // needs that distinction: the directory is missing, but the sessions that
    // lived there are not.
    if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true;
    }
  }

  if (current?.worktree) {
    entries.push(current);
  }

  return entries;
};

const canonicalPath = async (input) => {
  const absolutePath = path.resolve(input);
  const realPath = await fsp.realpath(absolutePath).catch(() => absolutePath);
  const normalized = path.normalize(realPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const checkPathExists = async (targetPath) => {
  try {
    await fsp.stat(targetPath);
    return true;
  } catch {
    return false;
  }
};

const normalizeStartRef = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return 'HEAD';
  }
  return trimmed;
};

function isValidCommitHash(hash) {
  return typeof hash === 'string' && /^[0-9a-fA-F]{7,40}$/.test(hash);
}

const parseRemoteBranchRef = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('refs/remotes/')) {
    const rest = trimmed.substring('refs/remotes/'.length);
    const slashIndex = rest.indexOf('/');
    if (slashIndex <= 0 || slashIndex === rest.length - 1) {
      return null;
    }
    return {
      remote: rest.slice(0, slashIndex),
      branch: rest.slice(slashIndex + 1),
      remoteRef: rest,
      fullRef: `refs/remotes/${rest}`,
    };
  }

  if (trimmed.startsWith('remotes/')) {
    return parseRemoteBranchRef(`refs/${trimmed}`);
  }

  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return null;
  }

  return {
    remote: trimmed.slice(0, slashIndex),
    branch: trimmed.slice(slashIndex + 1),
    remoteRef: trimmed,
    fullRef: `refs/remotes/${trimmed}`,
  };
};

const resolveRemoteBranchRef = async (primaryWorktree, value) => {
  const raw = String(value || '').trim();
  const parsed = parseRemoteBranchRef(raw);
  if (!parsed) {
    return null;
  }

  if (raw.startsWith('refs/remotes/') || raw.startsWith('remotes/')) {
    return parsed;
  }

  const localRef = `refs/heads/${raw}`;
  const localExists = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', localRef]);
  if (localExists.success) {
    return null;
  }

  return parsed;
};

/**
 * The remote a checkout made from a local ref hydrates from.
 *
 * Submodules and Git LFS are fetched from the same place the checkout came
 * from. A remote-tracking start ref names that place; a local branch does not,
 * so its upstream remote stands in, and failing that the repository's only
 * remote. Null when nothing names one.
 */
const resolveCheckoutRemoteName = async (primaryWorktree, startRef) => {
  const raw = String(startRef || '').trim();
  const branch = raw && raw !== 'HEAD'
    ? raw.replace(/^refs\/heads\//, '')
    : (await runGitCommand(primaryWorktree, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
  if (branch) {
    const upstream = await runGitCommand(primaryWorktree, ['config', '--get', `branch.${branch}.remote`]);
    const name = upstream.success ? upstream.stdout.trim() : '';
    if (name) return name;
  }
  const remotes = await runGitCommand(primaryWorktree, ['remote']);
  const names = remotes.success ? remotes.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : [];
  if (names.length === 1) return names[0];
  return names.includes('origin') ? 'origin' : '';
};

const normalizeUpstreamTarget = (remote, branch) => {
  const remoteName = String(remote || '').trim();
  const branchName = String(branch || '').trim();
  if (!remoteName || !branchName) {
    return null;
  }
  return {
    remote: remoteName,
    branch: branchName,
    full: `${remoteName}/${branchName}`,
  };
};

const parseGitErrorText = (error) => {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  // Some runtimes (notably Bun + simple-git GitError) surface the fatal text
  // primarily via message/toString; keep String(error) as a last resort so
  // "not a git repository" matching never misses and aborts callers.
  const fallback = !message && error != null ? String(error) : '';
  const chunks = [stderr, stdout, message, fallback]
    .map((chunk) => String(chunk || '').trim())
    .filter(Boolean);
  // execFile's message already embeds stderr; a chunk another one contains
  // would print every git error line twice.
  return chunks
    .filter((chunk, index) => !chunks.some((other, otherIndex) => otherIndex !== index && other.length > chunk.length && other.includes(chunk)))
    .join('\n')
    .trim();
};

const parseAheadBehindCounts = (value) => {
  const [aheadRaw, behindRaw] = String(value || '').trim().split(/\s+/);
  const ahead = parseInt(aheadRaw, 10);
  const behind = parseInt(behindRaw, 10);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return null;
  }
  return { ahead, behind };
};

const getRemoteExistenceCacheKey = (directory, remoteName) => {
  const normalizedDirectory = normalizeDirectoryPath(directory) || '';
  return `${path.resolve(normalizedDirectory)}\0${remoteName}`;
};

const hasRemote = async (git, directory, remoteName) => {
  const remote = String(remoteName || '').trim();
  if (!remote) {
    return false;
  }

  const key = getRemoteExistenceCacheKey(directory, remote);
  const cached = remoteExistenceCache.get(key);
  if (cached && Date.now() - cached.checkedAt < REMOTE_EXISTENCE_CACHE_TTL_MS) {
    return cached.exists;
  }

  const exists = await git
    .raw(['remote', 'get-url', '--', remote])
    .then((value) => String(value || '').trim().length > 0)
    .catch(() => false);

  remoteExistenceCache.set(key, { exists, checkedAt: Date.now() });
  return exists;
};

const buildRawGitOptions = (raw) => {
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value || '').trim()).filter(Boolean);
  }

  if (!raw || typeof raw !== 'object') {
    return [];
  }

  return Object.entries(raw).flatMap(([key, value]) => {
    const option = String(key || '').trim();
    if (!option || value === false) {
      return [];
    }
    if (value === true || value == null) {
      return [option];
    }
    return [option, String(value)];
  });
};

const getRemoteBranchComparison = async (git, remoteName, branchName) => {
  const remote = String(remoteName || '').trim();
  const branch = String(branchName || '').trim();
  if (!remote || !branch) {
    return null;
  }

  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const exists = await git
    .raw(['rev-parse', '--verify', remoteRef])
    .then((value) => String(value || '').trim())
    .catch(() => '');
  if (!exists) {
    return null;
  }

  const countsRaw = await git
    .raw(['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`])
    .then((value) => String(value || '').trim())
    .catch(() => '');
  const counts = parseAheadBehindCounts(countsRaw);
  if (!counts) {
    return null;
  }

  return {
    remote,
    branch,
    ahead: counts.ahead,
    behind: counts.behind,
  };
};

const isNotGitRepositoryError = (error) => {
  const text = parseGitErrorText(error);
  return /not a git repository/i.test(text);
};

// A directory that no longer exists (e.g. a worktree deleted while something
// was still polling its status) is an expected, benign condition — not a fault
// to scream about. simple-git throws "Cannot use simple-git on a directory that
// does not exist"; the underlying fs errors are ENOENT/ENOTDIR.
const isMissingDirectoryError = (error) => {
  const code = error?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return true;
  }
  const text = parseGitErrorText(error);
  return /directory that does not exist|does not exist|no such file or directory/i.test(text);
};

const runGitCommand = async (cwd, args, { env: envOverride, timeoutMs = 0 } = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync(getGitBinary(), args, {
      cwd,
      env: envOverride || await buildGitEnv(),
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      // Only short probes pass a timeout; commands that legitimately run long
      // (a fetch into a temporary clone) keep the default of none.
      ...(timeoutMs > 0 ? { timeout: timeoutMs, killSignal: 'SIGKILL' } : {}),
    });
    return {
      success: true,
      exitCode: 0,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
    };
  } catch (error) {
    return {
      success: false,
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
      message: parseGitErrorText(error),
    };
  }
};

// simple-git 3.36 refuses GIT_EDITOR unless allowUnsafeEditor is enabled, and
// once an instance has an explicit env it also rejects inherited PAGER or
// GIT_ASKPASS values. Run editor-free continuation commands directly instead.
const runGitCommandWithoutEditor = async (cwd, args) => {
  const result = await runGitCommand(cwd, args, { env: { GIT_EDITOR: 'true' } });
  if (!result.success) {
    throw new Error(result.message || 'Git command failed');
  }
};

const runGitCommandOrThrow = async (cwd, args, fallbackMessage) => {
  const result = await runGitCommand(cwd, args);
  if (!result.success) {
    throw new Error(result.message || fallbackMessage || 'Git command failed');
  }
  return result;
};

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isIndexLockError = (result) => {
  const message = [result?.message, result?.stderr, result?.stdout].filter(Boolean).join('\n');
  return /index\.lock['"]?: File exists|another git process seems to be running/i.test(message);
};

const getWorktreeIndexLockPath = async (directory) => {
  const result = await runGitCommand(directory, ['rev-parse', '--git-path', 'index.lock']);
  if (!result.success) {
    return null;
  }
  const value = normalizeGitOutputPath(String(result.stdout || '').trim());
  return value ? (path.isAbsolute(value) ? value : path.resolve(directory, value)) : null;
};

const getFileIdentity = async (filePath) => {
  try {
    const stat = await fsp.stat(filePath);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

// OpenChamber places managed worktrees under a deep data-dir path
// (`<XDG_DATA_HOME>/opencode/worktree/<40-char project id>/<name>/`). On
// Windows that prefix plus a deeply nested repo file routinely exceeds
// MAX_PATH (260). Git can check those paths out when core.longpaths is
// enabled; without it, `git reset --hard` during bootstrap fails with
// "Filename too long" and leaves a half-populated worktree (issue #2746).
const WORKTREE_POPULATE_CONFIG_ARGS = [
  '-c', 'core.longpaths=true',
  '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
  '-c', 'core.fsmonitor=false',
  '-c', 'submodule.recurse=false',
  '-c', 'fetch.recurseSubmodules=false',
  '-c', 'filter.lfs.process=',
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.clean=',
  '-c', 'filter.lfs.required=false',
];

const buildWorktreePopulateCommand = async (directory) => {
  const env = {
    ...(await buildGitEnv()),
    GIT_ALLOW_PROTOCOL: '',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  delete env.GIT_CONFIG_PARAMETERS;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  }
  const configured = await runGitCommand(directory, [
    ...WORKTREE_POPULATE_CONFIG_ARGS,
    'config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(process|smudge|clean|required)$',
  ], { env });
  if (!configured.success && configured.exitCode !== 1) {
    throw new Error('Failed to inspect Git filters before populating worktree');
  }
  if (configured.stdout && !configured.stdout.endsWith('\0')) {
    throw new Error('Git filter configuration is invalid');
  }
  const filterArgs = [];
  for (const key of configured.stdout.split('\0').filter(Boolean)) {
    if (!/^filter\.[^\0\r\n=]+\.(process|smudge|clean|required)$/i.test(key)) {
      throw new Error('Git filter configuration is invalid');
    }
    filterArgs.push('-c', `${key}=${key.toLowerCase().endsWith('.required') ? 'false' : ''}`);
  }
  return {
    args: [...WORKTREE_POPULATE_CONFIG_ARGS, ...filterArgs, 'reset', '--hard'],
    env,
  };
};

const isFilenameTooLongError = (message) => /file ?name too long/i.test(String(message || ''));

const formatWorktreePopulateError = (message) => {
  const text = String(message || '').trim() || 'Failed to populate worktree';
  if (!isFilenameTooLongError(text)) {
    return text;
  }
  return [
    text,
    'The worktree checkout path exceeds this system\'s path-length limit.',
    'OpenChamber enables Git `core.longpaths` for worktree population; if this still fails on Windows, enable OS long paths (LongPathsEnabled) or open the repository from a shorter absolute path.',
  ].join('\n');
};

export const ensureWorktreeLongpaths = async (directory) => {
  const current = await runGitCommand(directory, ['config', '--get', 'core.longpaths']);
  if (String(current.stdout || '').trim().toLowerCase() === 'true') {
    return;
  }
  // Local config is shared across linked worktrees via the common git dir, so
  // subsequent OpenChamber and CLI git operations in this repo also get long
  // path support. Failures here are non-fatal: populate still passes
  // `-c core.longpaths=true` on reset.
  await runGitCommand(directory, ['config', 'core.longpaths', 'true']);
};

export const populateWorktreeWithLockRecovery = async (directory) => {
  await ensureWorktreeLongpaths(directory);
  const command = await buildWorktreePopulateCommand(directory);

  let result = await runGitCommand(directory, command.args, { env: command.env });
  if (result.success) {
    return;
  }
  if (!isIndexLockError(result)) {
    throw new Error(formatWorktreePopulateError(result.message));
  }

  await wait(WORKTREE_INDEX_LOCK_RETRY_DELAY_MS);
  result = await runGitCommand(directory, command.args, { env: command.env });
  if (result.success) {
    return;
  }
  if (!isIndexLockError(result)) {
    throw new Error(formatWorktreePopulateError(result.message));
  }

  const lockPath = await getWorktreeIndexLockPath(directory);
  const identity = lockPath ? await getFileIdentity(lockPath) : null;
  await wait(WORKTREE_INDEX_LOCK_STALE_DELAY_MS);

  result = await runGitCommand(directory, command.args, { env: command.env });
  if (result.success) {
    return;
  }
  if (!isIndexLockError(result) || !lockPath || !identity || await getFileIdentity(lockPath) !== identity) {
    throw new Error(formatWorktreePopulateError(result.message));
  }

  await fsp.unlink(lockPath).catch((error) => {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  });
  const finalResult = await runGitCommand(directory, command.args, { env: command.env });
  if (!finalResult.success) {
    throw new Error(formatWorktreePopulateError(finalResult.message || 'Failed to populate worktree'));
  }
};

const inspectPostCheckoutHook = async (directory) => {
  const result = await runGitCommand(directory, ['rev-parse', '--git-path', 'hooks']);
  if (!result.success) return null;
  const hooksPath = normalizeDirectoryPath(normalizeGitOutputPath(String(result.stdout || '').trim()));
  if (!hooksPath) return null;
  const hookPath = path.join(path.isAbsolute(hooksPath) ? hooksPath : path.resolve(directory, hooksPath), 'post-checkout');
  let handle;
  try {
    handle = await fsp.open(hookPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o111) === 0)) return null;
    const content = await handle.readFile();
    const gitDirResult = await runGitCommand(directory, ['rev-parse', '--absolute-git-dir']);
    const gitDir = normalizeGitOutputPath(String(gitDirResult.stdout || '').trim());
    if (!gitDirResult.success || !gitDir) return null;
    return {
      kind: 'post-checkout-hook',
      path: hookPath,
      content,
      contentDigest: crypto.createHash('sha256').update(content).digest('base64url'),
      gitDir,
      workTree: path.resolve(directory),
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
};

export const inspectContributorCheckoutActions = async (directory, provenance) => {
  const head = String((await runGitCommandOrThrow(directory, ['rev-parse', 'HEAD'], 'Failed to inspect worktree HEAD')).stdout || '').trim().toLowerCase();
  if (head !== provenance.sourceSha) throw Object.assign(new Error('Contributor worktree HEAD changed'), { code: 'STALE_CONFIG', status: 409 });
  const hook = await inspectPostCheckoutHook(directory);
  const projectCommand = await loadProjectStartCommand(provenance.projectId);
  const setupCommand = String(provenance.setupCommand || '').trim();
  const actions = [];
  if (hook) actions.push(hook);
  if (projectCommand) actions.push({ kind: 'project-start-command', command: projectCommand });
  if (setupCommand) actions.push({ kind: 'setup-command', command: setupCommand });
  const digestActions = actions.map((action) => action.kind === 'post-checkout-hook' ? {
    kind: action.kind,
    path: action.path,
    contentDigest: action.contentDigest,
    gitDir: action.gitDir,
    workTree: action.workTree,
    args: [GIT_NULL_REF, head, '1'],
  } : action);
  const digest = crypto.createHash('sha256').update(JSON.stringify({ head, actions: digestActions })).digest('base64url');
  return Object.freeze({ state: 'awaiting-trust', actions: Object.freeze(actions), digest });
};

const derivePrimaryWorktreeRootFromGitDir = (gitDir) => {
  const normalized = normalizePath(gitDir);
  if (!normalized) return null;
  if (normalized.endsWith('/.git')) {
    return normalized.slice(0, -'/.git'.length) || null;
  }
  const marker = '/.git/worktrees/';
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex > 0) {
    return normalized.slice(0, markerIndex) || null;
  }
  return null;
};

export async function resolvePrimaryWorktreeRoot(directory) {
  const result = await runGitCommand(directory, ['rev-parse', '--absolute-git-dir', '--git-common-dir']);
  if (!result.success) {
    return { root: directory };
  }
  const lines = String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const absoluteGitDir = normalizePath(normalizeGitOutputPath(lines[0] || ''));
  const rootFromAbsoluteGitDir = derivePrimaryWorktreeRootFromGitDir(absoluteGitDir);
  if (rootFromAbsoluteGitDir) {
    return { root: rootFromAbsoluteGitDir };
  }
  const rawCommonDir = normalizePath(normalizeGitOutputPath(lines[1] || ''));
  if (rawCommonDir) {
    const commonDir = path.isAbsolute(rawCommonDir)
      ? rawCommonDir
      : path.resolve(directory, rawCommonDir);
    const rootFromCommonDir = derivePrimaryWorktreeRootFromGitDir(commonDir);
    if (rootFromCommonDir) {
      return { root: rootFromCommonDir };
    }
  }
  return { root: directory };
}

export async function resolveRepositoryGitPaths(directory) {
  const result = await runGitCommand(directory, [
    'rev-parse',
    '--absolute-git-dir',
    '--path-format=absolute',
    '--git-common-dir',
    '--is-bare-repository',
  ]);
  if (!result.success) {
    return { supported: false, reason: 'not-a-git-repository' };
  }
  const lines = String(result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) return { supported: false, reason: 'unresolved-git-directory' };
  const gitDirectory = path.resolve(directory, lines[0]);
  const commonDirectory = path.resolve(directory, lines[1]);
  return {
    supported: true,
    gitDirectory,
    commonDirectory,
    bare: lines[2] === 'true',
  };
}

/**
 * Each listed remote's fetch and push URL from `git remote -v` output, as
 * `git remote get-url [--push]` reports them: the first URL of several, and a
 * remote with no URL read as a URL equal to its name, as Git does. Lines may
 * end in CRLF (Git for Windows); a kept `\r` would match no line and read
 * every remote as URL-less.
 */
export function parseRemoteListing(names, listing) {
  const urls = new Map();
  for (const line of String(listing || '').split(/\r?\n/)) {
    const match = line.match(/^([^\t]+)\t(.*) \((fetch|push)\)$/);
    if (!match) continue;
    const entry = urls.get(match[1]) ?? {};
    if (entry[match[3]] === undefined) entry[match[3]] = match[2];
    urls.set(match[1], entry);
  }
  return names.map((name) => {
    const fetchUrl = urls.get(name)?.fetch ?? name;
    return { name, fetchUrl, pushUrl: urls.get(name)?.push ?? fetchUrl };
  });
}

/**
 * Each remote's fetch and push URL as `git remote get-url [--push]` reports
 * them (`insteadOf` rewrites applied), read with one `git remote -v` instead
 * of two Git processes per remote: repository identity is resolved several
 * times per Git operation, and a repository with many remotes spent most of
 * that time starting processes. When the listing itself fails, each remote is
 * asked on its own, so a failure never reads as URL-less remotes.
 */
export async function getRepositoryRemoteUrls(directory) {
  const [namesResult, listResult] = await Promise.all([
    runGitCommand(directory, ['remote']),
    runGitCommand(directory, ['remote', '-v']),
  ]);
  if (!namesResult.success) return [];
  const names = String(namesResult.stdout || '').split(/\r?\n/).map((name) => name.trim()).filter(Boolean).sort();
  if (listResult.success) return parseRemoteListing(names, listResult.stdout);
  return Promise.all(names.map(async (name) => {
    const [fetchResult, pushResult] = await Promise.all([
      runGitCommand(directory, ['remote', 'get-url', name]),
      runGitCommand(directory, ['remote', 'get-url', '--push', name]),
    ]);
    const fetchUrl = fetchResult.success ? String(fetchResult.stdout || '').trim() : '';
    const pushUrl = pushResult.success ? String(pushResult.stdout || '').trim() : fetchUrl;
    return { name, fetchUrl, pushUrl };
  }));
}

export async function resolveWorktreeTopLevel(directory) {
  const result = await runGitCommand(directory, ['rev-parse', '--show-toplevel']);
  if (!result.success) {
    return { root: directory };
  }
  const root = normalizePath(normalizeGitOutputPath(String(result.stdout || '').trim()));
  return { root: root || directory };
}


const integrateService = createIntegrateService({ runGitCommand, runGitCommandOrThrow, normalizeDirectoryPath, path, os, fsp });
export const { computeIntegratePlan, getIntegrateConflictDetails, isCherryPickInProgress,
  integrateWorktreeCommits, abortIntegrate, continueIntegrate } = integrateService;

const ensureOpenCodeProjectId = async (primaryWorktree) => {
  const gitDir = path.join(primaryWorktree, '.git');
  const idFile = path.join(gitDir, 'opencode');
  const existing = await fsp.readFile(idFile, 'utf8').then((value) => value.trim()).catch(() => '');
  if (existing) {
    return existing;
  }

  const rootsResult = await runGitCommandOrThrow(
    primaryWorktree,
    ['rev-list', '--max-parents=0', '--all'],
    'Failed to resolve repository roots'
  );

  const roots = rootsResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const projectId = roots[0] || '';
  if (!projectId) {
    throw new Error('Failed to derive OpenCode project ID');
  }

  await fsp.mkdir(gitDir, { recursive: true }).catch(() => undefined);
  await fsp.writeFile(idFile, projectId, 'utf8').catch(() => undefined);

  return projectId;
};

const resolveWorktreeProjectContext = async (directory, options = {}) => {
  const tolerateWorktreeRootConfigError = options?.tolerateWorktreeRootConfigError === true;
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath) {
    throw new Error('Directory is required');
  }

  const topResult = await runGitCommandOrThrow(
    directoryPath,
    ['rev-parse', '--show-toplevel'],
    'Failed to resolve git top-level directory'
  );
  const sandbox = path.resolve(directoryPath, normalizeGitOutputPath(topResult.stdout.trim()));

  const commonResult = await runGitCommandOrThrow(
    sandbox,
    ['rev-parse', '--git-common-dir'],
    'Failed to resolve git common directory'
  );
  const commonDir = path.resolve(sandbox, normalizeGitOutputPath(commonResult.stdout.trim()));
  const primaryWorktree = path.dirname(commonDir);
  const projectID = await ensureOpenCodeProjectId(primaryWorktree);
  // OpenCode's `worktree.directory` is read from the canonical checkout so a
  // linked worktree still sees the project's saved configuration. When unset,
  // worktrees keep landing in the data-dir folder keyed by project ID.
  const legacyWorktreeRoot = path.join(getOpenCodeDataPath(), 'worktree', projectID);
  // Creation must not guess a folder the user did not choose, so a config read
  // failure propagates there. Read-only and removal paths pass
  // `tolerateWorktreeRootConfigError` and fall back to the data-dir root, so an
  // unreadable config never blocks removing a worktree that already exists.
  let configuredWorktreeRoot = null;
  try {
    configuredWorktreeRoot = readWorktreeDirectorySetting(primaryWorktree);
  } catch (error) {
    if (!tolerateWorktreeRootConfigError) {
      throw error;
    }
    console.warn(
      'Failed to read OpenCode worktree.directory; using the data-dir worktree root:',
      error instanceof Error ? error.message : String(error),
    );
  }
  const worktreeRoot = configuredWorktreeRoot || legacyWorktreeRoot;

  return {
    projectID,
    sandbox,
    primaryWorktree,
    worktreeRoot,
    legacyWorktreeRoot,
  };
};

const listWorktreeEntries = async (directory) => {
  const rawResult = await runGitCommandOrThrow(
    directory,
    ['worktree', 'list', '--porcelain'],
    'Failed to list git worktrees'
  );
  return parseWorktreePorcelain(rawResult.stdout);
};

const resolveWorktreeNameCandidates = (baseName) => {
  const normalizedBase = slugWorktreeName(baseName || '');
  if (!normalizedBase) {
    return Array.from({ length: OPENCODE_WORKTREE_ATTEMPTS }, () => generateOpenCodeRandomName());
  }
  return Array.from({ length: OPENCODE_WORKTREE_ATTEMPTS }, (_, index) => {
    if (index === 0) {
      return normalizedBase;
    }
    return `${normalizedBase}-${generateOpenCodeRandomName()}`;
  });
};

const resolveCandidateDirectory = async (worktreeRoot, preferredName, explicitBranchName, primaryWorktree) => {
  const candidates = resolveWorktreeNameCandidates(preferredName);

  for (const name of candidates) {
    const directory = path.join(worktreeRoot, name);
    if (await checkPathExists(directory)) {
      continue;
    }

    if (explicitBranchName) {
      return { name, directory, branch: explicitBranchName };
    }

    const branch = `openchamber/${name}`;
    const branchRef = `refs/heads/${branch}`;
    const branchExists = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', branchRef]);
    if (branchExists.success) {
      continue;
    }

    return { name, directory, branch };
  }

  throw new Error('Failed to generate a unique worktree name');
};

const resolveBranchForExistingMode = async (primaryWorktree, existingBranch, preferredBranchName) => {
  const requested = String(existingBranch || '').trim();
  if (!requested) {
    throw new Error('existingBranch is required in existing mode');
  }

  const normalizedLocal = cleanBranchName(requested);
  const localRef = `refs/heads/${normalizedLocal}`;
  const localExists = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', localRef]);
  if (localExists.success) {
    return {
      localBranch: normalizedLocal,
      checkoutRef: normalizedLocal,
      createLocalBranch: false,
      remoteRef: null,
    };
  }

  const remoteRef = parseRemoteBranchRef(requested);
  if (!remoteRef) {
    throw new Error(`Branch not found: ${requested}`);
  }

  const remoteExists = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', remoteRef.fullRef]);
  if (!remoteExists.success) {
    throw new Error(`Remote branch is not available locally: ${requested}. Fetch it explicitly and retry.`);
  }

  const localBranch = cleanBranchName(preferredBranchName || remoteRef.branch || requested);
  if (!localBranch) {
    throw new Error('Failed to resolve local branch name for existing branch worktree');
  }

  return {
    localBranch,
    checkoutRef: remoteRef.remoteRef,
    createLocalBranch: true,
    remoteRef,
  };
};

const findBranchInUse = async (primaryWorktree, localBranchName) => {
  if (!localBranchName) {
    return null;
  }
  const entries = await listWorktreeEntries(primaryWorktree);
  const targetRef = `refs/heads/${localBranchName}`;
  const targetClean = cleanBranchName(targetRef);
  return entries.find((entry) => {
    const entryRef = String(entry.branchRef || '').trim();
    const entryClean = cleanBranchName(entryRef || entry.branch || '');
    return entryRef === targetRef || entryClean === targetClean;
  }) || null;
};

const runWorktreeStartCommand = async (directory, command) => {
  const text = String(command || '').trim();
  if (!text) {
    return { success: true };
  }

  if (process.platform === 'win32') {
    const result = await execFileAsync('cmd', ['/c', text], {
      cwd: directory,
      env: await buildGitEnv(),
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    }).then(({ stdout, stderr }) => ({ success: true, stdout, stderr })).catch((error) => ({
      success: false,
      stdout: error?.stdout,
      stderr: error?.stderr,
      message: parseGitErrorText(error),
    }));
    return result;
  }

  const result = await execFileAsync('bash', ['-lc', text], {
    cwd: directory,
    env: await buildGitEnv(),
    maxBuffer: 20 * 1024 * 1024,
  }).then(({ stdout, stderr }) => ({ success: true, stdout, stderr })).catch((error) => ({
    success: false,
    stdout: error?.stdout,
    stderr: error?.stderr,
    message: parseGitErrorText(error),
  }));
  return result;
};

const loadProjectStartCommand = async (projectID) => {
  const storagePath = path.join(getOpenCodeDataPath(), 'storage', 'project', `${projectID}.json`);
  try {
    const raw = await fsp.readFile(storagePath, 'utf8');
    const parsed = JSON.parse(raw);
    const start = typeof parsed?.commands?.start === 'string' ? parsed.commands.start.trim() : '';
    return start || '';
  } catch {
    return '';
  }
};

// OpenCode owns its own project/sandbox registry. It records a worktree as a
// sandbox itself when an instance boots for that directory, and filters entries
// whose directory no longer exists when reading them back. OpenChamber used to
// write that state directly into OpenCode's storage JSON and SQLite database,
// behind the back of the running process: the row changed but the server was
// never told, so a worktree created while OpenCode was running stayed unknown
// to it until a restart. Registration is not ours to perform.

const isAttachedGitWorktreeDirectory = async (directory) => {
  try {
    const result = await runGitCommand(directory, ['rev-parse', '--is-inside-work-tree']);
    return result.success && String(result.stdout || '').trim() === 'true';
  } catch {
    return false;
  }
};

const cleanupFailedFastWorktreeCreate = async (context, candidate) => {
  const candidateDirectory = path.resolve(candidate.directory);
  const worktreeRoot = path.resolve(context.worktreeRoot);
  const isInsideWorktreeRoot = isInsideOrSameDirectory(worktreeRoot, candidateDirectory) && candidateDirectory !== worktreeRoot;
  const isAttached = await isAttachedGitWorktreeDirectory(candidateDirectory);

  if (!isInsideWorktreeRoot || isAttached) {
    return;
  }

  try {
    const entries = await fsp.readdir(candidateDirectory);
    if (entries.length === 0) {
      await fsp.rmdir(candidateDirectory);
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) {
      console.warn('Failed to clean up empty worktree directory after creation failure:', error instanceof Error ? error.message : String(error));
    }
  }
};

const runWorktreeStartScripts = async (directory, projectID, startCommand) => {
  const projectStart = await loadProjectStartCommand(projectID);
  if (projectStart) {
    const projectResult = await runWorktreeStartCommand(directory, projectStart);
    if (!projectResult.success) {
      console.warn('Worktree project start command failed:', projectResult.message || projectResult.stderr || projectResult.stdout);
      return;
    }
  }

  const extraCommand = String(startCommand || '').trim();
  if (!extraCommand) {
    return;
  }
  const extraResult = await runWorktreeStartCommand(directory, extraCommand);
  if (!extraResult.success) {
    console.warn('Worktree start command failed:', extraResult.message || extraResult.stderr || extraResult.stdout);
  }
};

const queueWorktreeBootstrap = (args) => {
  const {
    directory,
    projectID,
    primaryWorktree,
    localBranch,
    setUpstream,
    upstreamRemote,
    upstreamBranch,
    ensureRemoteName,
    ensureRemoteUrl,
    startCommand,
    contributorFork,
    hydrateCheckout,
    checkoutRemoteName,
    bootstrapStore,
  } = args;
  const task = new Promise((resolve) => setTimeout(resolve, 0))
    .then(async () => {
      await populateWorktreeWithLockRecovery(directory);
      const hydration = hydrateCheckout ? await hydrateCheckout({
        directory,
        parentRemoteName: checkoutRemoteName,
      }) : null;
      if (hydrateCheckout && !hydration) {
        throw new Error('Worktree checkout hydration returned no result');
      }
      if (hydration && !['succeeded', 'not-needed'].includes(hydration.status)) {
        const itemError = [...hydration.submodules, ...hydration.lfs]
          .find((item) => item.status === hydration.status)?.error;
        throw Object.assign(new Error(itemError?.message || 'Worktree checkout hydration did not complete'), {
          code: itemError?.code || 'TRANSPORT_FAILED', hydration,
        });
      }
      if (setUpstream) {
        await applyUpstreamConfiguration({
          primaryWorktree,
          worktreeDirectory: directory,
          localBranch,
          setUpstream,
          upstreamRemote,
          upstreamBranch,
          ensureRemoteName,
          ensureRemoteUrl,
        }).catch((error) => {
          console.warn('Worktree upstream configuration failed:', error instanceof Error ? error.message : String(error));
        });
      }
      await setWorktreeBootstrapState(
        directory,
        WORKTREE_BOOTSTRAP_PENDING,
        WORKTREE_BOOTSTRAP_PHASE_GIT_READY,
        null,
        undefined,
        undefined,
        bootstrapStore,
      );
      if (!contributorFork) {
        await runWorktreeStartScripts(directory, projectID, startCommand).catch((error) => {
          console.warn('Worktree start script task failed:', error instanceof Error ? error.message : String(error));
        });
      }
      await setWorktreeBootstrapState(
        directory,
        WORKTREE_BOOTSTRAP_READY,
        WORKTREE_BOOTSTRAP_PHASE_SETUP_READY,
        null,
        undefined,
        undefined,
        bootstrapStore,
      );
    })
    .catch(async (error) => {
      const recordedPhase = worktreeBootstrapState.get(await toCanonicalBootstrapStateKey(directory))?.phase;
      const pathLengthFailure = !error?.hydration
        && isFilenameTooLongError(error instanceof Error ? error.message : error);
      const publicMessage = error?.hydration
        ? error instanceof Error ? error.message : 'Worktree checkout hydration did not complete'
        : pathLengthFailure
          ? formatWorktreePopulateError(error instanceof Error ? error.message : error)
          : 'Worktree bootstrap failed. Inspect the checkout and repair it before use.';
      await setWorktreeBootstrapState(
        directory,
        WORKTREE_BOOTSTRAP_FAILED,
        recordedPhase === WORKTREE_BOOTSTRAP_PHASE_GIT_READY
          ? WORKTREE_BOOTSTRAP_PHASE_GIT_READY
          : WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED,
        publicMessage,
        error?.hydration,
        bootstrapFailureCode(error, pathLengthFailure),
        bootstrapStore,
      ).catch(() => {});
      console.warn('Worktree bootstrap task failed:', error instanceof Error ? error.message : String(error));
    });

  trackWorktreeBootstrapTask(directory, task);
};

const withRemoteProvisioningQueue = async (primaryWorktree, remoteName, task) => {
  const key = `${path.resolve(primaryWorktree)}::${remoteName}`;
  const previous = remoteProvisioningQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  const tail = current.catch(() => {});
  remoteProvisioningQueues.set(key, tail);
  try {
    return await current;
  } finally {
    if (remoteProvisioningQueues.get(key) === tail) remoteProvisioningQueues.delete(key);
  }
};

const ensureRemoteWithUrlUnlocked = async (primaryWorktree, remoteName, remoteUrl) => {
  const name = String(remoteName || '').trim();
  const url = String(remoteUrl || '').trim();
  if (!name || !url) {
    return;
  }

  const getUrl = await runGitCommand(primaryWorktree, ['remote', 'get-url', '--', name]);
  if (getUrl.success) {
    const currentUrl = String(getUrl.stdout || '').trim();
    if (currentUrl !== url) {
      const error = new Error(`Remote ${name} already exists with a different endpoint`);
      error.code = 'CONTRIBUTOR_REMOTE_COLLISION';
      error.status = 409;
      error.remoteName = name;
      throw error;
    }
    return;
  }

  await runGitCommandOrThrow(primaryWorktree, ['remote', 'add', '--', name, url], 'Failed to add git remote');
};

const ensureRemoteWithUrl = (primaryWorktree, remoteName, remoteUrl) => withRemoteProvisioningQueue(
  primaryWorktree,
  remoteName,
  () => ensureRemoteWithUrlUnlocked(primaryWorktree, remoteName, remoteUrl)
);

const captureRemoteUrl = async (primaryWorktree, remoteName) => {
  const result = await runGitCommand(primaryWorktree, ['remote', 'get-url', remoteName]);
  return result.success
    ? { exists: true, url: String(result.stdout || '').trim() }
    : { exists: false, url: '' };
};

const restoreProvisionedRemote = async (primaryWorktree, remoteName, provisionedUrl, previous) => {
  const current = await captureRemoteUrl(primaryWorktree, remoteName);
  if (!current.exists) {
    if (!previous.exists) return;
    throw new Error(`Remote ${remoteName} changed during worktree creation`);
  }
  if (current.url !== provisionedUrl) {
    throw new Error(`Remote ${remoteName} changed during worktree creation`);
  }
  if (previous.exists) {
    return;
  }
  await runGitCommandOrThrow(primaryWorktree, ['remote', 'remove', '--', remoteName], 'Failed to remove provisioned git remote');
};

/**
 * Shared existing-mode resolver for validate + create.
 * Provisioned remotes (`ensureRemoteName`/`ensureRemoteUrl`) are used for fork
 * PR heads; other existing branches keep the local / already-fetched remote path.
 *
 * @param {'validate'|'create'} intent
 */
const resolveExistingWorktreeSource = async (primaryWorktree, input = {}, intent = 'create') => {
  const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());
  const ensureRemoteName = String(input?.ensureRemoteName || '').trim();
  const ensureRemoteUrl = String(input?.ensureRemoteUrl || '').trim();
  const requestedExistingBranch = String(input?.existingBranch || '').trim();
  const wantUpstream = Boolean(input?.setUpstream);
  const explicitUpstreamRemote = String(input?.upstreamRemote || '').trim();
  const explicitUpstreamBranch = String(input?.upstreamBranch || '').trim();
  const expectedRevision = String(input?.expectedRevision || '').trim();
  const contributorTransferComplete = input?.contributorFork === true
    && input?.contributorTransferComplete === true;
  const parsedExistingRemote = await resolveRemoteBranchRef(primaryWorktree, requestedExistingBranch);

  if (
    parsedExistingRemote
    && ensureRemoteName
    && ensureRemoteUrl
    && parsedExistingRemote.remote === ensureRemoteName
  ) {
    if (contributorTransferComplete) {
      if (intent === 'create') {
        await ensureRemoteWithUrlUnlocked(primaryWorktree, ensureRemoteName, ensureRemoteUrl);
      }
      const transferredRevision = await runGitCommand(
        primaryWorktree,
        ['rev-parse', '--verify', parsedExistingRemote.remoteRef]
      );
      if (!transferredRevision.success
        || (expectedRevision && String(transferredRevision.stdout || '').trim() !== expectedRevision)) {
        throw new Error('Transferred branch revision does not match the requested change request head');
      }
    } else {
      if (intent === 'create') {
        await ensureRemoteWithUrlUnlocked(primaryWorktree, ensureRemoteName, ensureRemoteUrl);
      }
      const localRevision = await runGitCommand(
        primaryWorktree,
        ['rev-parse', '--verify', parsedExistingRemote.remoteRef]
      );
      if (!localRevision.success) {
        throw new Error(`Remote branch is not available locally: ${parsedExistingRemote.remoteRef}. Transfer it explicitly and retry.`);
      }
      if (expectedRevision && String(localRevision.stdout || '').trim() !== expectedRevision) {
        throw new Error('Remote branch revision does not match the requested change request head');
      }
    }

    const localBranch = cleanBranchName(preferredBranchName || parsedExistingRemote.branch);
    return {
      localBranch,
      checkoutRef: parsedExistingRemote.remoteRef,
      createLocalBranch: true,
      setUpstream: wantUpstream,
      upstream: {
        remote: explicitUpstreamRemote || parsedExistingRemote.remote,
        branch: explicitUpstreamBranch || parsedExistingRemote.branch,
      },
    };
  }

  if (!requestedExistingBranch) {
    throw new Error('existingBranch is required in existing mode');
  }

  const resolved = await resolveBranchForExistingMode(
    primaryWorktree,
    requestedExistingBranch,
    preferredBranchName
  );
  if (expectedRevision) {
    const resolvedRevision = await runGitCommand(primaryWorktree, ['rev-parse', '--verify', resolved.checkoutRef]);
    if (!resolvedRevision.success || String(resolvedRevision.stdout || '').trim() !== expectedRevision) {
      throw new Error('Existing branch revision does not match the requested change request head');
    }
  }
  const upstream = resolved.remoteRef
    ? {
        remote: explicitUpstreamRemote || resolved.remoteRef.remote,
        branch: explicitUpstreamBranch || resolved.remoteRef.branch,
      }
    : (explicitUpstreamRemote && explicitUpstreamBranch
      ? { remote: explicitUpstreamRemote, branch: explicitUpstreamBranch }
      : null);

  return {
    localBranch: resolved.localBranch,
    checkoutRef: resolved.checkoutRef,
    createLocalBranch: resolved.createLocalBranch,
    setUpstream: wantUpstream && Boolean(upstream),
    upstream,
  };
};

const checkLocalRemoteBranchExists = async (primaryWorktree, remoteName, branchName) => {
  const remote = String(remoteName || '').trim();
  const branch = String(branchName || '').trim();
  if (!remote || !branch) {
    return { success: false, found: false };
  }

  const localRef = await runGitCommand(
    primaryWorktree,
    ['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`]
  );
  return {
    success: true,
    found: localRef.success,
  };
};

const applyUpstreamConfiguration = async (args) => {
  const {
    primaryWorktree,
    worktreeDirectory,
    localBranch,
    setUpstream,
    upstreamRemote,
    upstreamBranch,
    ensureRemoteName,
    ensureRemoteUrl,
  } = args;

  if (!setUpstream) {
    return;
  }

  if (ensureRemoteName && ensureRemoteUrl) {
    await ensureRemoteWithUrl(primaryWorktree, ensureRemoteName, ensureRemoteUrl);
  }

  const upstream = normalizeUpstreamTarget(upstreamRemote, upstreamBranch);
  if (!upstream || !localBranch) {
    return;
  }

  const upstreamRef = await runGitCommand(
    primaryWorktree,
    ['show-ref', '--verify', '--quiet', `refs/remotes/${upstream.remote}/${upstream.branch}`]
  );
  if (!upstreamRef.success) {
    return;
  }

  await runGitCommandOrThrow(
    worktreeDirectory,
    ['branch', `--set-upstream-to=${upstream.full}`, localBranch],
    `Failed to set upstream to ${upstream.full}`
  );
};

const warnedUnsupportedRoots = new Set();

export async function isGitRepository(directory) {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath || !fs.existsSync(directoryPath)) {
    return false;
  }

  const result = await runGitCommand(directoryPath, ['rev-parse', '--git-dir'], { timeoutMs: GIT_PROBE_TIMEOUT_MS });
  if (!result.success) return false;

  // `--show-toplevel` has no answer inside a bare repository or a .git
  // directory; those keep the previous answer rather than being rejected.
  const topLevel = await runGitCommand(directoryPath, ['rev-parse', '--show-toplevel'], { timeoutMs: GIT_PROBE_TIMEOUT_MS });
  if (!topLevel.success) return true;
  const repoRoot = topLevel.stdout.trim();
  const reason = unsupportedRepositoryRootReason(repoRoot);
  if (!reason) return true;
  if (!warnedUnsupportedRoots.has(repoRoot)) {
    warnedUnsupportedRoots.add(repoRoot);
    console.warn(`[git] Ignoring repository rooted at ${repoRoot} (${reason}): Git features are disabled for ${directoryPath}`);
  }
  return false;
}

export async function getRemoteUrl(directory, remoteName = 'origin') {
  const git = await createGit(directory);

  try {
    const url = await git.remote(['get-url', '--', remoteName]);
    return url?.trim() || null;
  } catch {
    return null;
  }
}

const identityService = createIdentityService({ createGit, createGitForGlobalConfig, normalizeDirectoryPath, runGitCommand });
export const { getGlobalIdentity, getCurrentIdentity, hasLocalIdentity, clearLocalIdentity, setLocalIdentity, configureRepositoryTransport } = identityService;

export const { getStatus, getTrackingBranch } = createStatusService({
  buildGitEnv, createRepositoryGitContext, getGitBinary, hasRemote, isGitRepository,
  isMissingDirectoryError, isNotGitRepositoryError, normalizeDirectoryPath,
  resolveGitInternalPath, runGitCommand, getRemoteBranchComparison,
});

const { getDiff, getPathDiff, getNoIndexDiff } = createDiffService({
  createRepositoryGitContext, readSubmoduleState, resolveGitFileContext, runGitCommand,
});
export { getDiff, getPathDiff };

const { getFileDiff, revertFile, applyHunk, collectDiffs, stageFiles, unstageFiles } = createFileService({
  createRepositoryGitContext, createGit, getGitBinary, getDiff, resolveGitFileContext,
  resolveGitRepositoryRoot, normalizeDirectoryPath, normalizeFilePathList,
  validateRepositoryFilePaths, withGitIndexMutationQueue, runGitCommand,
  readSubmoduleState, parseGitErrorText,
});
export { getFileDiff, revertFile, applyHunk, stageFiles, unstageFiles };

const branchQueriesService = createBranchQueriesService({ createRepositoryGitContext });
const branchService = createBranchesService({
  createRepositoryGitContext, cleanBranchName,
  normalizeUpstreamTarget, isValidCommitHash, isNotGitRepositoryError, runGitCommandOrThrow,
  getBranches: branchQueriesService.getBranches,
  getUnpushedBranchCounts: branchQueriesService.getUnpushedBranchCounts,
});
export const { parseBranchCreationSource, getBranchBase, getBranches, getUnpushedBranchCounts,
  createBranch, checkoutBranch, checkoutCommit, cherryPick, revertCommit, resetToCommit,
  deleteBranch, renameBranch, getRemotes, removeRemote } = branchService;

const historyService = createHistoryService({
  createRepositoryGitContext, runGitCommandOrThrow, runGitCommand,
  resolveGitFileContext, toGitPath,
});
export const { resolveBaseRefForLog, getLog, getCommitSummaries, getCommitDiff, getCommitFiles, getCommitFileDiff } = historyService;

const rangeDiffService = createRangeDiffService({
  createGit, createRepositoryGitContext, resolveGitFileContext, runGitCommand,
  gitPathNotFound: GIT_PATH_NOT_FOUND, isInsideOrSameDirectory, toGitPath,
});
export const { getRangeDiff, getRangeFiles } = rangeDiffService;

// Whether `sha` is reachable from the checked-out HEAD. An object git has never
// fetched fails the same way an unrelated commit does: not an ancestor.
export async function isAncestorOfHead(directory, sha) {
  const normalizedDirectory = normalizeDirectoryPath(directory);
  const normalizedSha = typeof sha === 'string' ? sha.trim() : '';
  if (!normalizedDirectory || !/^[0-9a-f]{7,64}$/i.test(normalizedSha)) {
    return false;
  }
  const result = await runGitCommand(normalizedDirectory, ['merge-base', '--is-ancestor', normalizedSha, 'HEAD']);
  return result.success;
}



/**
 * Individual untracked file paths, honoring ignore rules.
 *
 * Deliberately not `--directory`: collapsed directory entries end in a slash
 * and are not valid inputs to the per-file diff helpers, so a caller would
 * silently lose every file inside a new directory. Listing files costs more
 * entries but each one is usable.
 *
 * Callers that only need this list should not pay for `getStatus`, which also
 * computes ahead/behind, diff stats, and merge state — an order of magnitude
 * more work for an answer they throw away.
 */
export async function listUntrackedPaths(directory) {
  const { repoRoot } = await createRepositoryGitContext(directory);
  const result = await runGitCommand(repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
  ]);
  if (!result.success) return [];
  return String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Diffs for untracked files, produced against an empty tree.
 *
 * `getDiff` re-resolves the repository context on every call, which costs an
 * extra `rev-parse` per file; a walkthrough of a branch with thirty new files
 * pays that thirty times. This resolves once and reuses it, with a bounded pool
 * so a repository full of new files cannot flood the process table.
 *
 * Returns one entry per input path, in order; unreadable paths yield `''`
 * rather than failing the batch.
 */
export async function getUntrackedDiffs(directory, filePaths = [], { concurrency = 8, contextLines = 3 } = {}) {
  const paths = (Array.isArray(filePaths) ? filePaths : []).filter((value) => typeof value === 'string' && value);
  if (paths.length === 0) return [];

  const { directoryPath, directoryGit, repoRoot } = await createRepositoryGitContext(directory);
  const results = new Array(paths.length).fill('');
  let cursor = 0;

  const worker = async () => {
    while (cursor < paths.length) {
      const index = cursor++;
      try {
        const fileContext = await resolveGitFileContext(directoryPath, directoryGit, paths[index], repoRoot);
        results[index] = await getNoIndexDiff(repoRoot, fileContext.repoPath, contextLines);
      } catch {
        results[index] = '';
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return results;
}

export async function listStashes(directory) {
  const { git } = await createRepositoryGitContext(directory);
  const output = await git.raw(['stash', 'list', '--format=%gd%x1f%gs%x1f%cr%x1f%H']);
  return String(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [ref = '', message = '', relativeTime = '', hash = ''] = line.split('\x1f');
      return { ref, message, relativeTime, hash };
    })
    .filter((entry) => entry.ref);
}

/** @public */
export async function countStashFiles(directory, refs = []) {
  const { git } = await createRepositoryGitContext(directory);
  const uniqueRefs = Array.from(new Set((Array.isArray(refs) ? refs : []).map((ref) => String(ref || '').trim()).filter(Boolean)));
  const counts = {};
  const concurrency = 4;
  let cursor = 0;

  const worker = async () => {
    while (cursor < uniqueRefs.length) {
      const ref = uniqueRefs[cursor++];
      if (!ref) continue;
      try {
        const names = await git.raw(['stash', 'show', '--name-only', ref]);
        counts[ref] = String(names || '').split('\n').map((line) => line.trim()).filter(Boolean).length;
      } catch {
        counts[ref] = 0;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueRefs.length) }, () => worker()));
  return counts;
}
/** @public */
export async function stashPush(directory, options = {}) {
  const { git } = await createRepositoryGitContext(directory);
  const message = typeof options.message === 'string' && options.message.trim()
    ? options.message.trim()
    : `OpenChamber stash ${new Date().toISOString()}`;
  const output = await git.raw(['stash', 'push', '--include-untracked', '-m', message]);
  return {
    success: true,
    created: !/no local changes/i.test(String(output || '')),
    message,
    output: String(output || '').trim(),
  };
}

/** @public */
export async function stashApply(directory, options = {}) {
  const { git } = await createRepositoryGitContext(directory);
  const ref = typeof options.ref === 'string' && options.ref.trim() ? options.ref.trim() : 'stash@{0}';
  // Prefer --index so the staged/unstaged split captured in the stash is restored
  // faithfully. Fall back to a plain apply when the index can't be reinstated
  // cleanly (e.g. conflicts), which is the prior behavior.
  await git.raw(['stash', 'apply', '--index', ref]).catch(async () => {
    await git.raw(['stash', 'apply', ref]);
  });
  return { success: true, ref };
}

/** @public */
export async function stashDrop(directory, options = {}) {
  const { git } = await createRepositoryGitContext(directory);
  const ref = typeof options.ref === 'string' && options.ref.trim() ? options.ref.trim() : 'stash@{0}';
  await git.raw(['stash', 'drop', ref]);
  return { success: true, ref };
}

/** @public */
export async function stashPop(directory, options = {}) {
  const ref = typeof options.ref === 'string' && options.ref.trim() ? options.ref.trim() : 'stash@{0}';
  await stashApply(directory, { ref });
  await stashDrop(directory, { ref });
  return { success: true, ref };
}


export async function commit(directory, message, options = {}) {
  return withGitIndexMutationQueue(directory, async () => {
    const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
    // An identity applied here writes the repository's own author, and that is
    // what a commit uses. A repository on the System identity deliberately has
    // none: it says no override applies, so the machine's own author answers,
    // which is what Git itself would do. The panel names that author before
    // the commit, so it is a stated choice rather than an ambient surprise.
    const [localUserName, localUserEmail] = await Promise.all([
      git.getConfig('user.name', 'local').catch(() => null),
      git.getConfig('user.email', 'local').catch(() => null),
    ]);
    if (!localUserName?.value?.trim() || !localUserEmail?.value?.trim()) {
      const [globalUserName, globalUserEmail] = await Promise.all([
        git.getConfig('user.name', 'global').catch(() => null),
        git.getConfig('user.email', 'global').catch(() => null),
      ]);
      if (!globalUserName?.value?.trim() || !globalUserEmail?.value?.trim()) {
        throw new Error('No Git author is configured. Choose an identity for this repository, or set user.name and user.email on this computer.');
      }
    }
    let temporarilyUnstagedFiles = [];

    try {
      const requestedFiles = Array.isArray(options.files)
        ? options.files
          .map((value) => String(value || '').trim())
          .filter(Boolean)
        : [];
      const requestedStageFiles = Array.isArray(options.stageFiles)
        ? options.stageFiles
          .map((value) => String(value || '').trim())
          .filter(Boolean)
        : null;
      let filesToCommit = [];
      let commitFromIndexOnly = false;

      if (options.addAll) {
        await git.add('.');
      } else if (requestedFiles.length > 0) {
        filesToCommit = Array.from(new Set(await Promise.all(requestedFiles.map(async (filePath) => {
          const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
          return fileContext.repoPath;
        }))));

        const stageFilesToCommit = requestedStageFiles
          ? Array.from(new Set(await Promise.all(requestedStageFiles.map(async (filePath) => {
            const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
            return fileContext.repoPath;
          }))))
          : null;

        const status = await git.status();
        const fileStatusByPath = new Map(status.files.map((file) => [file.path, file]));
      filesToCommit = filesToCommit.filter((filePath) => fileStatusByPath.has(filePath));

        if (filesToCommit.length === 0) {
          throw new Error('No selected files are available to commit. Refresh git status and try again.');
        }

        if (requestedStageFiles) {
          commitFromIndexOnly = true;
          const selectedFileSet = new Set(filesToCommit);
          temporarilyUnstagedFiles = status.files
            .filter((file) => {
              const indexStatus = (file.index || '').trim();
              return indexStatus && indexStatus !== '?' && !selectedFileSet.has(file.path);
            })
            .map((file) => file.path);

          if (temporarilyUnstagedFiles.length > 0) {
            await git.raw(['restore', '--staged', '--', ...temporarilyUnstagedFiles]);
          }
        }

        const filesNeedingAdd = requestedStageFiles
          ? (stageFilesToCommit || []).filter((filePath) => fileStatusByPath.has(filePath))
          : filesToCommit.filter((filePath) => {
            const fileStatus = fileStatusByPath.get(filePath);
            if (!fileStatus) {
              return false;
            }

            const alreadyFullyStaged = fileStatus.index !== ' ' && fileStatus.working_dir === ' ';
            return !alreadyFullyStaged;
          });

        if (filesNeedingAdd.length > 0) {
          await git.raw(['add', '--', ...filesNeedingAdd]);
        }
      }

      const commitArgs =
        !commitFromIndexOnly && !options.addAll && filesToCommit.length > 0
          ? filesToCommit
          : undefined;

      let result;
      try {
        result = await git.commit(message, commitArgs);
      } catch (error) {
        const gitErrorText = parseGitErrorText(error);
        const isPathspecError = gitErrorText.includes('pathspec') && gitErrorText.includes('did not match any files');
        if (!isPathspecError || !commitArgs || commitArgs.length === 0) {
          throw error;
        }

        // Fallback for deleted/stale selections: commit currently staged changes.
        result = await git.commit(message);
      }

      if (temporarilyUnstagedFiles.length > 0) {
        await git.raw(['add', '--', ...temporarilyUnstagedFiles]).catch((restoreError) => {
          console.error('Failed to restore temporarily unstaged files:', restoreError);
        });
      }

      return {
        success: true,
        commit: result.commit,
        branch: result.branch,
        summary: result.summary
      };
    } catch (error) {
      if (temporarilyUnstagedFiles.length > 0) {
        await git.raw(['add', '--', ...temporarilyUnstagedFiles]).catch((restoreError) => {
          console.error('Failed to restore temporarily unstaged files after commit failure:', restoreError);
        });
      }
      console.error('Failed to commit:', error);
      throw error;
    }
  });
}

const worktreeTopologyService = createWorktreeService({
  createGit, isNotGitRepositoryError, normalizeDirectoryPath, normalizeGitOutputPath,
  parseWorktreePorcelain, resolveGitRepositoryRoot, runGitCommand, runGitCommandOrThrow,
});
export const { getWorktrees, subscribeWorktreeTopologyChanges, observeWorktreeTopology } = worktreeTopologyService;
const publishWorktreeTopologyChange = worktreeTopologyService.publishWorktreeTopologyChange;

export async function validateWorktreeCreate(directory, input = {}) {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const errors = [];

  try {
    const context = await resolveWorktreeProjectContext(directory);
    const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());
    const startRef = normalizeStartRef(input?.startRef);
    const ensureRemoteName = String(input?.ensureRemoteName || '').trim();
    const ensureRemoteUrl = String(input?.ensureRemoteUrl || '').trim();
    const contributorFork = input?.contributorFork === true;
    const requestedExistingBranch = String(input?.existingBranch || '').trim();
    let remoteCollision = false;
    if (contributorFork && ensureRemoteName && ensureRemoteUrl) {
      const existingRemote = await captureRemoteUrl(context.primaryWorktree, ensureRemoteName);
      remoteCollision = existingRemote.exists && existingRemote.url !== ensureRemoteUrl;
      if (remoteCollision) {
        errors.push({
          code: 'remote_name_collision',
          message: `Remote ${ensureRemoteName} already exists with a different endpoint`,
        });
      }
    }
    // A change request's head (a fork's or this repository's own) is fetched
    // after validation, so its ref cannot be checked before that.
    const contributorNeedsTransfer = (contributorFork || input?.changeRequestTransfer === true)
      && input?.contributorTransferComplete !== true;

    let localBranch = '';
    let inferredUpstream = null;

    if (mode === 'existing') {
      if (contributorNeedsTransfer) {
        errors.push({
          code: 'contributor_transfer_unavailable',
          message: 'Contributor worktree transfer requires managed credentials',
        });
      } else if (!remoteCollision) {
        try {
          const resolved = await resolveExistingWorktreeSource(context.primaryWorktree, input, 'validate');
          localBranch = resolved.localBranch || '';
          if (resolved.upstream) {
            inferredUpstream = {
              remote: resolved.upstream.remote,
              branch: resolved.upstream.branch,
            };
          }
        } catch (error) {
          errors.push({
            code: 'branch_not_found',
            message: error instanceof Error ? error.message : 'Existing branch not found',
          });
        }
      }
    } else if (contributorFork) {
      errors.push({
        code: 'contributor_transfer_unavailable',
        message: 'Contributor worktree transfer requires managed credentials',
      });
    } else {
      if (preferredBranchName) {
        const exists = await runGitCommand(context.primaryWorktree, ['show-ref', '--verify', '--quiet', `refs/heads/${preferredBranchName}`]);
        if (exists.success) {
          errors.push({
            code: 'branch_exists',
            message: `Branch already exists: ${preferredBranchName}`,
          });
        }
        localBranch = preferredBranchName;
      }

      const parsedRemoteRef = await resolveRemoteBranchRef(context.primaryWorktree, startRef);
      if (startRef && startRef !== 'HEAD') {
        if (parsedRemoteRef && ensureRemoteName && ensureRemoteUrl && ensureRemoteName === parsedRemoteRef.remote) {
          const remoteCheck = await checkLocalRemoteBranchExists(
            context.primaryWorktree,
            parsedRemoteRef.remote,
            parsedRemoteRef.branch
          );
          if (!remoteCheck.found) {
            errors.push({
              code: 'start_ref_not_found',
              message: `Remote branch is not available locally: ${parsedRemoteRef.remoteRef}`,
            });
          }
        } else if (parsedRemoteRef) {
          const remoteCheck = await checkLocalRemoteBranchExists(
            context.primaryWorktree,
            parsedRemoteRef.remote,
            parsedRemoteRef.branch
          );
          if (!remoteCheck.found) {
            errors.push({
              code: 'start_ref_not_found',
              message: `Remote branch is not available locally: ${parsedRemoteRef.remoteRef}`,
            });
          }
        } else {
          const startRefExists = await runGitCommand(context.primaryWorktree, ['rev-parse', '--verify', '--quiet', startRef]);
          if (!startRefExists.success) {
            errors.push({
              code: 'start_ref_not_found',
              message: `Start ref not found: ${startRef}`,
            });
          }
        }
      }

      if (parsedRemoteRef) {
        inferredUpstream = {
          remote: parsedRemoteRef.remote,
          branch: parsedRemoteRef.branch,
        };
      }
    }

    if (localBranch) {
      const inUse = await findBranchInUse(context.primaryWorktree, localBranch);
      if (inUse) {
        errors.push({
          code: 'branch_in_use',
          message: `Branch is already checked out in ${inUse.worktree}`,
        });
      }
    }

    if ((ensureRemoteName && !ensureRemoteUrl) || (!ensureRemoteName && ensureRemoteUrl)) {
      errors.push({
        code: 'invalid_remote_config',
        message: 'Both ensureRemoteName and ensureRemoteUrl are required together',
      });
    }

    const shouldSetUpstream = Boolean(input?.setUpstream);
    if (contributorFork && shouldSetUpstream) {
      errors.push({
        code: 'contributor_upstream_forbidden',
        message: 'Contributor worktrees cannot configure upstream tracking',
      });
    }
    if (shouldSetUpstream) {
      const upstreamRemote = String(input?.upstreamRemote || inferredUpstream?.remote || '').trim();
      const upstreamBranch = String(input?.upstreamBranch || inferredUpstream?.branch || '').trim();

      if (!upstreamRemote || !upstreamBranch) {
        errors.push({
          code: 'upstream_incomplete',
          message: 'upstreamRemote and upstreamBranch are required when setUpstream is true',
        });
      } else {
        const remoteExists = await runGitCommand(context.primaryWorktree, ['remote', 'get-url', '--', upstreamRemote]);
        if (!remoteExists.success && (!ensureRemoteName || ensureRemoteName !== upstreamRemote)) {
          errors.push({
            code: 'remote_not_found',
            message: `Remote not found: ${upstreamRemote}`,
          });
        }
      }
    }

    return {
      ok: errors.length === 0,
      errors,
      resolved: {
        mode,
        localBranch: localBranch || null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      errors: [{
        code: 'validation_failed',
        message: error instanceof Error ? error.message : 'Failed to validate worktree creation',
      }],
    };
  }
}

const assertWorktreeCreatePreflight = async (directory, input = {}) => {
  const validation = await validateWorktreeCreate(directory, input);
  if (validation?.ok) {
    return;
  }

  const message = validation?.errors
    ?.map((error) => error?.message)
    .filter(Boolean)
    .join('\n') || 'Failed to validate worktree creation';
  const collision = validation?.errors?.find((error) => error?.code === 'remote_name_collision');
  if (collision) {
    throw Object.assign(new Error(collision.message), {
      code: 'CONTRIBUTOR_REMOTE_COLLISION',
      status: 409,
      remoteName: String(input?.ensureRemoteName || '').trim(),
    });
  }
  if (validation?.errors?.some((error) => error?.code === 'contributor_transfer_unavailable')) {
    throw Object.assign(new Error('Contributor worktree transfer requires managed credentials'), {
      code: 'CONTRIBUTOR_MANAGED_TRANSFER_REQUIRED', status: 409,
    });
  }
  throw new Error(message);
};

export async function previewWorktreeCreate(directory, input = {}) {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const context = await resolveWorktreeProjectContext(directory);
  await fsp.mkdir(context.worktreeRoot, { recursive: true });

  const preferredName = String(input?.worktreeName || input?.name || '').trim();
  const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());
  const candidate = await resolveCandidateDirectory(
    context.worktreeRoot,
    preferredName,
    mode === 'new' && preferredBranchName ? preferredBranchName : '',
    context.primaryWorktree
  );

  return {
    name: candidate.name,
    branch: mode === 'new' ? candidate.branch : preferredBranchName,
    path: candidate.directory,
  };
}

async function attachGitWorktreeToCandidateWithoutRemoteRollback(context, candidate, input = {}, serverOptions = {}) {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const startRef = normalizeStartRef(input?.startRef);
  let ensureRemoteName = String(input?.ensureRemoteName || '').trim();
  let ensureRemoteUrl = String(input?.ensureRemoteUrl || '').trim();

  let localBranch = '';
  let inferredUpstream = null;
  let shouldSetUpstream = input?.contributorFork === true ? false : Boolean(input?.setUpstream);
  let checkoutRemoteName = '';
  const expectedRevision = String(input?.expectedRevision || '').trim();
  const contributorFork = input?.contributorFork === true;
  const contributorSource = serverOptions.contributorSource;
  if (contributorFork && (!ensureRemoteName || !ensureRemoteUrl || !expectedRevision
    || !contributorSource || !(serverOptions.contributorProvenance?.compareAndSwap instanceof Function))) {
    throw Object.assign(new Error('Contributor worktree provenance requirements are incomplete'), {
      code: 'INVALID_CONTRIBUTOR_WORKTREE', status: 400,
    });
  }
  let createdLocalBranch = false;
  const worktreeAddArgs = ['worktree', 'add', '--no-checkout'];

  if (mode === 'existing') {
    const resolved = await resolveExistingWorktreeSource(context.primaryWorktree, input, 'create');
    localBranch = resolved.localBranch;
    shouldSetUpstream = resolved.setUpstream;

    const inUse = await findBranchInUse(context.primaryWorktree, localBranch);
    if (inUse) {
      throw new Error(`Branch is already checked out in ${inUse.worktree}`);
    }

    if (resolved.createLocalBranch) {
      worktreeAddArgs.push('-b', localBranch);
      createdLocalBranch = true;
    }
    worktreeAddArgs.push(candidate.directory, expectedRevision && resolved.createLocalBranch
      ? expectedRevision
      : resolved.checkoutRef);

    if (resolved.upstream) {
      inferredUpstream = {
        remote: resolved.upstream.remote,
        branch: resolved.upstream.branch,
      };
    }
    if (resolved.createLocalBranch && resolved.upstream
      && (contributorFork || (ensureRemoteName && ensureRemoteUrl))) {
      checkoutRemoteName = resolved.upstream.remote;
    }
  } else {
    localBranch = candidate.branch;
    if (!localBranch) {
      throw new Error('Failed to resolve branch name for new worktree');
    }

    const branchExists = await runGitCommand(context.primaryWorktree, ['show-ref', '--verify', '--quiet', `refs/heads/${localBranch}`]);
    if (branchExists.success) {
      throw new Error(`Branch already exists: ${localBranch}`);
    }

    const inUse = await findBranchInUse(context.primaryWorktree, localBranch);
    if (inUse) {
      throw new Error(`Branch is already checked out in ${inUse.worktree}`);
    }

    worktreeAddArgs.push('-b', localBranch, candidate.directory);
    if (startRef && startRef !== 'HEAD') {
      worktreeAddArgs.push(startRef);
    }

    const parsedRemoteStartRef = await resolveRemoteBranchRef(context.primaryWorktree, startRef);
    if (parsedRemoteStartRef) {
      worktreeAddArgs.splice(2, 0, '--no-track');
      inferredUpstream = {
        remote: parsedRemoteStartRef.remote,
        branch: parsedRemoteStartRef.branch,
      };
      checkoutRemoteName = parsedRemoteStartRef.remote;
    }
  }

  if (mode === 'existing' && ensureRemoteName && ensureRemoteUrl) {
    await ensureRemoteWithUrlUnlocked(context.primaryWorktree, ensureRemoteName, ensureRemoteUrl);
  }
  if (!checkoutRemoteName) {
    checkoutRemoteName = await resolveCheckoutRemoteName(context.primaryWorktree, mode === 'existing' ? localBranch : startRef);
  }

  await runGitCommandOrThrow(context.primaryWorktree, worktreeAddArgs, 'Failed to create git worktree');
  await publishWorktreeTopologyChange(context.primaryWorktree);

  if (expectedRevision) {
    const createdHead = await runGitCommand(candidate.directory, ['rev-parse', '--verify', 'HEAD']);
    if (!createdHead.success || String(createdHead.stdout || '').trim() !== expectedRevision) {
      const removed = await runGitCommand(context.primaryWorktree, ['worktree', 'remove', '--force', candidate.directory]);
      if (createdLocalBranch && removed.success) {
        const branchRemoved = await runGitCommand(context.primaryWorktree, ['branch', '-D', localBranch]);
        if (!branchRemoved.success) {
          throw new Error('Created worktree revision does not match the requested change request head, and the new local branch could not be removed safely');
        }
      }
      if (!removed.success) {
        throw new Error('Created worktree revision does not match the requested change request head, and the worktree could not be removed safely');
      }
      throw new Error('Created worktree revision does not match the requested change request head');
    }
  }

  let provenanceRecord = null;
  if (contributorFork) {
    try {
      provenanceRecord = await serverOptions.contributorProvenance.compareAndSwap(candidate.directory, 0, {
        kind: 'contributor-fork',
        remoteName: ensureRemoteName,
        endpointFingerprint: fingerprintRemoteUrl(ensureRemoteUrl),
        sourceSha: expectedRevision.toLowerCase(),
        sourceRef: contributorSource.headRef,
        sourceProjectId: contributorSource.sourceProject.id,
        targetProjectId: contributorSource.targetProject.id,
        provider: contributorSource.context.provider,
        instance: contributorSource.context.instance,
        accountId: contributorSource.context.accountId,
        bindingRevision: contributorSource.context.bindingRevision,
        primaryRemote: contributorSource.context.primaryRemote,
        projectId: context.projectID,
        setupCommand: String(input?.startCommand || '').trim(),
      });
    } catch (error) {
      const removed = await runGitCommand(context.primaryWorktree, ['worktree', 'remove', '--force', candidate.directory]);
      if (createdLocalBranch && removed.success) {
        await runGitCommand(context.primaryWorktree, ['branch', '-D', localBranch]);
      }
      throw error;
    }
  }

  const upstreamRemote = shouldSetUpstream
    ? String(input?.upstreamRemote || inferredUpstream?.remote || '').trim()
    : '';
  const upstreamBranch = shouldSetUpstream
    ? String(input?.upstreamBranch || inferredUpstream?.branch || '').trim()
    : '';

  let bootstrapStatus;
  try {
    bootstrapStatus = await setWorktreeBootstrapState(
      candidate.directory,
      WORKTREE_BOOTSTRAP_PENDING,
      WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED,
      null,
      undefined,
      undefined,
      serverOptions.bootstrapStore,
    );
  } catch (error) {
    if (error?.code !== 'WORKTREE_BOOTSTRAP_PERSISTENCE_FAILED') throw error;
    bootstrapStatus = error.bootstrapStatus;
  }

  if (bootstrapStatus.status === WORKTREE_BOOTSTRAP_PENDING) {
    queueWorktreeBootstrap({
      directory: candidate.directory,
      projectID: context.projectID,
      primaryWorktree: context.primaryWorktree,
      localBranch,
      setUpstream: shouldSetUpstream,
      upstreamRemote,
      upstreamBranch,
      ensureRemoteName,
      ensureRemoteUrl,
      startCommand: input?.startCommand,
      contributorFork,
      hydrateCheckout: serverOptions.hydrateCheckout,
      checkoutRemoteName,
      bootstrapStore: serverOptions.bootstrapStore,
    });
  }

  const headResult = await runGitCommand(candidate.directory, ['rev-parse', 'HEAD']);
  const head = String(headResult.stdout || '').trim();

  const result = {
    head,
    name: candidate.name,
    branch: localBranch,
    path: candidate.directory,
    directoryCreated: true,
    bootstrapStatus,
  };
  if (provenanceRecord) {
    result.provenance = {
      kind: 'contributor-fork',
      revision: provenanceRecord.revision,
      trust: 'untrusted',
      push: 'destination-selection-required',
    };
  }
  return result;
}

async function attachGitWorktreeToCandidate(context, candidate, input = {}, serverOptions = {}) {
  const remoteName = String(input?.ensureRemoteName || '').trim();
  const remoteUrl = String(input?.ensureRemoteUrl || '').trim();
  if (!remoteName || !remoteUrl) {
    return attachGitWorktreeToCandidateWithoutRemoteRollback(context, candidate, input, serverOptions);
  }
  return withRemoteProvisioningQueue(context.primaryWorktree, remoteName, async () => {
    const previous = await captureRemoteUrl(context.primaryWorktree, remoteName);
    try {
      return await attachGitWorktreeToCandidateWithoutRemoteRollback(context, candidate, input, serverOptions);
    } catch (error) {
      if (previous.exists && previous.url !== remoteUrl) throw error;
      try {
        await restoreProvisionedRemote(context.primaryWorktree, remoteName, remoteUrl, previous);
      } catch (rollbackError) {
        const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`${error instanceof Error ? error.message : String(error)}, and the provisioned remote could not be restored: ${detail}`);
      }
      throw error;
    }
  });
}

// Refreshes one remote-tracking ref before a worktree is created from it.
// This is server-internal maintenance of an already-configured remote, not a
// user-initiated transfer, so it stays outside the planned-operation flow.
const fetchRemoteBranchRef = async (primaryWorktree, remoteName, branchName) => {
  const remote = String(remoteName || '').trim();
  const branch = String(branchName || '').trim();
  if (!remote || !branch) {
    return;
  }

  const refspec = `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`;
  await runGitCommandOrThrow(
    primaryWorktree,
    ['fetch', '--', remote, refspec],
    `Failed to fetch ${remote}/${branch}`
  );
};

const isAncestorRef = async (cwd, ancestor, descendant) => {
  const result = await runGitCommand(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
  return result.success;
};

/**
 * The upstream of a local branch whose commits are all published, or null.
 *
 * Only the standard remote-tracking layout qualifies
 * (`refs/remotes/<remote>/<branch>`), because that is the ref
 * `fetchRemoteBranchRef` refreshes.
 */
const resolvePublishedLocalBranchUpstream = async (primaryWorktree, startRef) => {
  const branch = String(startRef || '').trim().replace(/^refs\/heads\//, '');
  if (!branch || branch === 'HEAD') return null;
  const localRef = `refs/heads/${branch}`;
  const refs = await runGitCommand(primaryWorktree, [
    'for-each-ref',
    '--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)',
    localRef,
  ]);
  if (!refs.success) return null;
  const line = refs.stdout.split('\n').find((entry) => entry.startsWith(`${localRef}\0`));
  if (!line) return null;
  const [, trackingRef, remote, remoteRef] = line.split('\0');
  const remoteBranch = String(remoteRef || '').replace(/^refs\/heads\//, '');
  if (!remote || !remoteBranch || trackingRef !== `refs/remotes/${remote}/${remoteBranch}`) return null;
  if (!(await isAncestorRef(primaryWorktree, localRef, trackingRef))) return null;
  return { remote, branch: remoteBranch, localRef, trackingRef };
};

/**
 * A local base branch with nothing unpublished starts the worktree from its
 * freshly fetched upstream, so the worktree includes what was pushed since
 * the last pull. The local branch itself is never moved. A branch with
 * unpublished commits, or an upstream that no longer contains the local
 * commits after the fetch (a force-push), keeps the local ref; a failed fetch
 * keeps it too and says so.
 */
// Why a fetch for a new worktree failed, when the user can do something about
// it: the repository's access (an account that needs attention, refused
// credentials). Anything else is left unnamed.
const sourceFetchFailure = (error) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const access = error?.reason === 'needs-attention' || error?.code === 'AUTHENTICATION_REQUIRED'
    || /authentication failed|could not read username|permission denied/i.test(message);
  return access ? { sourceFetchFailed: true, sourceFetchReason: 'access' } : { sourceFetchFailed: true };
};

const preparePublishedLocalBranchSource = async (context, input, startRef) => {
  const upstream = await resolvePublishedLocalBranchUpstream(context.primaryWorktree, startRef);
  if (!upstream) return { input, sourceFetchFailed: false };
  try {
    await fetchRemoteBranchRef(context.primaryWorktree, upstream.remote, upstream.branch);
  } catch (error) {
    return { input, ...sourceFetchFailure(error) };
  }
  if (!(await isAncestorRef(context.primaryWorktree, upstream.localRef, upstream.trackingRef))) {
    return { input, sourceFetchFailed: false };
  }
  return {
    input: { ...input, startRef: `remotes/${upstream.remote}/${upstream.branch}` },
    sourceFetchFailed: false,
  };
};

const prepareWorktreeCreateSource = async (context, input = {}) => {
  if (input?.mode === 'existing') {
    return { input, sourceFetchFailed: false };
  }

  const startRef = normalizeStartRef(input?.startRef);
  const remoteStartRef = await resolveRemoteBranchRef(context.primaryWorktree, startRef);
  if (!remoteStartRef) {
    return preparePublishedLocalBranchSource(context, input, startRef);
  }

  const status = await getStatus(context.primaryWorktree, { mode: 'light' }).catch(() => null);
  const trackingRef = status?.tracking
    ? await resolveRemoteBranchRef(context.primaryWorktree, status.tracking)
    : null;
  const canFallbackToLocal = Boolean(
    status?.current
    && status.ahead === 0
    && trackingRef?.fullRef === remoteStartRef.fullRef
  );

  try {
    await fetchRemoteBranchRef(context.primaryWorktree, remoteStartRef.remote, remoteStartRef.branch);
    return { input, sourceFetchFailed: false };
  } catch (error) {
    if (canFallbackToLocal) {
      return {
        input: { ...input, startRef: status.current },
        ...sourceFetchFailure(error),
      };
    }

    const refExists = await runGitCommand(
      context.primaryWorktree,
      ['show-ref', '--verify', '--quiet', remoteStartRef.fullRef]
    );
    if (!refExists.success) {
      throw error;
    }
    console.warn(`Worktree create: failed to refresh ${remoteStartRef.remote}/${remoteStartRef.branch}, proceeding with the existing remote-tracking ref`);
    return { input, sourceFetchFailed: false };
  }
};

export async function createWorktree(directory, input = {}, serverOptions = {}) {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const context = await resolveWorktreeProjectContext(directory);

  if (input?.returnAfterDirectoryCreated === true || input?.contributorFork === true) {
    await assertWorktreeCreatePreflight(directory, input);
  }

  // Only the non-existing path consults a remote before the attach step, and
  // only that path needs the remote provisioned this early. In existing mode
  // the attach step provisions it inside the rollback scope, so a failed
  // creation cannot leave a contributor remote behind.
  const ensureRemoteName = String(input?.ensureRemoteName || '').trim();
  const ensureRemoteUrl = String(input?.ensureRemoteUrl || '').trim();
  if (mode !== 'existing' && ensureRemoteName && ensureRemoteUrl) {
    await ensureRemoteWithUrl(context.primaryWorktree, ensureRemoteName, ensureRemoteUrl);
  }
  const prepared = await prepareWorktreeCreateSource(context, input);
  const preparedInput = prepared.input;

  await fsp.mkdir(context.worktreeRoot, { recursive: true });

  const preferredName = String(preparedInput?.worktreeName || preparedInput?.name || '').trim();
  const preferredBranchName = cleanBranchName(String(preparedInput?.branchName || '').trim());

  const candidate = await resolveCandidateDirectory(
    context.worktreeRoot,
    preferredName,
    mode === 'new' && preferredBranchName ? preferredBranchName : '',
    context.primaryWorktree
  );

  if (preparedInput?.returnAfterDirectoryCreated === true && preparedInput?.contributorFork !== true) {
    await fsp.mkdir(candidate.directory, { recursive: false });

    let bootstrapStatus;
    try {
      bootstrapStatus = await setWorktreeBootstrapState(
        candidate.directory,
        WORKTREE_BOOTSTRAP_PENDING,
        WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED,
        null,
        undefined,
        undefined,
        serverOptions.bootstrapStore,
      );
    } catch (error) {
      if (error?.code !== 'WORKTREE_BOOTSTRAP_PERSISTENCE_FAILED') throw error;
      bootstrapStatus = error.bootstrapStatus;
    }
    const localBranch = mode === 'existing'
      ? cleanBranchName(String(preparedInput?.branchName || preparedInput?.existingBranch || candidate.branch || '').trim())
      : candidate.branch;

    const task = bootstrapStatus.status === WORKTREE_BOOTSTRAP_PENDING
      ? attachGitWorktreeToCandidate(context, candidate, preparedInput, serverOptions).catch(async (error) => {
      await setWorktreeBootstrapState(
        candidate.directory,
        WORKTREE_BOOTSTRAP_FAILED,
        WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED,
        'Worktree creation failed. Inspect the checkout and repair it before use.',
        undefined,
        'UNKNOWN',
        serverOptions.bootstrapStore,
      ).catch(() => {});
      await cleanupFailedFastWorktreeCreate(context, candidate);
      console.warn('Background worktree creation failed:', error instanceof Error ? error.message : String(error));
      })
      : null;
    if (task) trackWorktreeBootstrapTask(candidate.directory, task);

    const result = {
      head: '',
      name: candidate.name,
      branch: localBranch,
      path: candidate.directory,
      directoryCreated: true,
      bootstrapStatus,
    };
    if (prepared.sourceFetchFailed) {
      result.sourceFetchFailed = true;
      if (prepared.sourceFetchReason) result.sourceFetchReason = prepared.sourceFetchReason;
    }
    return result;
  }

  const result = await attachGitWorktreeToCandidate(context, candidate, preparedInput, serverOptions);
  if (!prepared.sourceFetchFailed) return result;
  return prepared.sourceFetchReason
    ? { ...result, sourceFetchFailed: true, sourceFetchReason: prepared.sourceFetchReason }
    : { ...result, sourceFetchFailed: true };
}

// The code a failed bootstrap is recorded with, which decides what the user is
// told. A known cause is never recorded as unknown: a repository grant whose
// account needs attention reads as the access problem it is.
const bootstrapFailureCode = (error, pathLengthFailure) => {
  if (error?.hydration) return error.code;
  if (pathLengthFailure) return 'PATH_LENGTH_LIMIT';
  if (error?.reason === 'needs-attention' || error?.code === 'AUTHENTICATION_REQUIRED') return 'AUTHENTICATION_REQUIRED';
  return 'UNKNOWN';
};

const inspectWorktreeBootstrapRecovery = async (directory) => {
  const attached = await runGitCommand(directory, ['rev-parse', '--is-inside-work-tree']);
  if (!attached.success || String(attached.stdout || '').trim() !== 'true') {
    return createWorktreeBootstrapState(
      WORKTREE_BOOTSTRAP_FAILED,
      WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED,
      WORKTREE_BOOTSTRAP_RECOVERY_ERROR,
      undefined,
      'UNKNOWN',
    );
  }
  const head = await runGitCommand(directory, ['rev-parse', '--verify', 'HEAD']);
  const indexMatchesHead = await runGitCommand(directory, ['diff', '--cached', '--quiet', 'HEAD', '--']);
  const deleted = await runGitCommand(directory, ['ls-files', '--deleted', '-z']);
  const checkoutPopulated = head.success && String(head.stdout || '').trim()
    && indexMatchesHead.success && deleted.success && !String(deleted.stdout || '');
  return createWorktreeBootstrapState(
    WORKTREE_BOOTSTRAP_FAILED,
    checkoutPopulated ? WORKTREE_BOOTSTRAP_PHASE_GIT_READY : WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED,
    WORKTREE_BOOTSTRAP_RECOVERY_ERROR,
    undefined,
    'UNKNOWN',
  );
};

// A directory with no bootstrap record was never populated by this server and
// reads as ready, the same rule the OpenCode proxy's checkout gate applies.
// Inspection runs only for a record left `pending` with no live bootstrap behind
// it, a crash mid-population. An unreadable store is not an absent record and
// still fails closed.
const notBootstrappedHere = () => createWorktreeBootstrapState(
  WORKTREE_BOOTSTRAP_READY,
  WORKTREE_BOOTSTRAP_PHASE_SETUP_READY,
);

export async function getWorktreeBootstrapStatus(directory, { bootstrapStore } = {}) {
  const key = await toCanonicalBootstrapStateKey(directory);
  if (!key) {
    throw new Error('Worktree directory is required');
  }

  if (bootstrapStore) {
    try {
      const persisted = await bootstrapStore.read(key);
      if (!persisted) {
        return worktreeBootstrapState.get(key) ?? notBootstrappedHere();
      }
      if (persisted.status !== WORKTREE_BOOTSTRAP_PENDING || await hasActiveWorktreeBootstrap(key)) {
        worktreeBootstrapState.set(key, persisted);
        return persisted;
      }
      const blocker = await inspectWorktreeBootstrapRecovery(key);
      worktreeBootstrapState.set(key, blocker);
      await bootstrapStore.write(key, blocker);
      return blocker;
    } catch {
      const blocker = await inspectWorktreeBootstrapRecovery(key);
      worktreeBootstrapState.set(key, blocker);
      return blocker;
    }
  }
  return worktreeBootstrapState.get(key) ?? notBootstrappedHere();
}

export async function completeWorktreeCheckoutHydration(directory, { bootstrapStore } = {}) {
  const key = await toCanonicalBootstrapStateKey(directory);
  if (!key) throw new Error('Worktree directory is required');
  if (bootstrapStore) {
    const completed = await bootstrapStore.completeHydration(key);
    if (completed) worktreeBootstrapState.set(key, completed);
    return completed;
  }
  const current = worktreeBootstrapState.get(key);
  if (current?.status !== WORKTREE_BOOTSTRAP_FAILED || !current.hydration
    || ['succeeded', 'not-needed'].includes(current.hydration.status)) return null;
  const completed = createWorktreeBootstrapState(
    WORKTREE_BOOTSTRAP_READY,
    WORKTREE_BOOTSTRAP_PHASE_SETUP_READY,
  );
  worktreeBootstrapState.set(key, completed);
  return completed;
}



const worktreeStateService = createWorktreeStateService({
  fsp, path, os, normalizeDirectoryPath, runGitCommand, runGitCommandOrThrow,
  buildGitEnv, createGit, isGitRepository, canonicalPath, resolveGitRepositoryRoot,
  resolveGitInternalPath, cleanBranchName, resolveWorktreeProjectContext,
});
export const { snapshotWorktree, isLinkedWorktree, validateWorktreeDirectory, canonicalizeWorktreeState } = worktreeStateService;

const worktreeRemovalService = createWorktreeRemovalService({
  fsp, path, process, console, normalizeDirectoryPath, canonicalPath,
  waitForActiveWorktreeBootstrap, clearWorktreeBootstrapState,
  resolveWorktreeProjectContext, listWorktreeEntries, runGitCommand,
  runGitCommandOrThrow, isInsideOrSameDirectory, checkPathExists,
  getFileIdentity, toGitPath, cleanBranchName, wait, isLinkedWorktree,
  publishWorktreeTopologyChange,
});
export const removeWorktree = (...args) => worktreeRemovalService(...args);

const mergeService = createMergeService({ createRepositoryGitContext, runGitCommandWithoutEditor, resolveGitInternalPath, fsp });
export const { rebase, abortRebase, merge, abortMerge, continueRebase, continueMerge, getConflictDetails } = mergeService;
