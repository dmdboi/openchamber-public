import { createStatusService } from './services/status.js';
import { createDiffService } from './services/diff.js';
import { createFileService } from './services/files.js';
import { createWorktreeService } from './services/worktrees.js';
import { createWorktreeStateService } from './services/worktree-state.js';
import { createWorktreeRemovalService } from './services/worktree-removal.js';
import { createWorktreeBootstrapStateService } from './services/worktree-bootstrap-state.js';
import { createWorktreeCreationService } from './services/worktree-creation.js';
import { createWorktreePopulationService, isFilenameTooLongError, formatWorktreePopulateError } from './services/worktree-population.js';
import { createBranchesService } from './services/branches.js';
import { createBranchQueriesService } from './services/branch-queries.js';
import { createIdentityService } from './services/identity.js';
import { createRangeDiffService } from './services/range-diff.js';
import { createHistoryService } from './services/history.js';
import { createIntegrateService } from './services/integrate.js';
import { createMergeService } from './services/merge.js';
import { createRepositoryOperationsService } from './services/repository-operations.js';
import {
  buildGitEnv,
  createGit,
  createGitForGlobalConfig,
  createRepositoryGitContext,
  getGitBinary,
  isInsideOrSameDirectory,
  normalizeDirectoryPath,
  normalizeFilePathList,
  normalizePath,
  resolveGitRepositoryRoot,
  toGitPath,
  validateRepositoryFilePaths,
  withGitIndexMutationQueue,
} from './runtime.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'node:crypto';
import { fingerprintRemoteUrl } from '../source-control/url-redaction.js';
import { readWorktreeDirectorySetting } from '../opencode/shared.js';
import { normalizeGitOutputPath } from './output-path.js';
import { unsupportedRepositoryRootReason } from './repository-root.js';

export { getRepositoryRoot } from './runtime.js';

const fsp = fs.promises;
const GIT_PROBE_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);
const remoteExistenceCache = new Map();
const REMOTE_EXISTENCE_CACHE_TTL_MS = 30_000;


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

const { getFileDiff, revertFile, applyHunk, collectDiffs, stageFile, stageFiles, unstageFile, unstageFiles } = createFileService({
  createRepositoryGitContext, createGit, getGitBinary, getDiff, resolveGitFileContext,
  resolveGitRepositoryRoot, normalizeDirectoryPath, normalizeFilePathList,
  validateRepositoryFilePaths, withGitIndexMutationQueue, runGitCommand,
  readSubmoduleState, parseGitErrorText,
});
export { getFileDiff, revertFile, applyHunk, collectDiffs, stageFile, stageFiles, unstageFile, unstageFiles };

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

const repositoryOperationsService = createRepositoryOperationsService({
  createRepositoryGitContext, runGitCommand, normalizeDirectoryPath,
  resolveGitFileContext, getNoIndexDiff, withGitIndexMutationQueue, parseGitErrorText,
});
export const { isAncestorOfHead, listUntrackedPaths, getUntrackedDiffs, listStashes,
  countStashFiles, stashPush, stashApply, stashDrop, stashPop, commit } = repositoryOperationsService;

const worktreeTopologyService = createWorktreeService({
  createGit, isNotGitRepositoryError, normalizeDirectoryPath, normalizeGitOutputPath,
  parseWorktreePorcelain, resolveGitRepositoryRoot, runGitCommand, runGitCommandOrThrow,
});
export const { getWorktrees, subscribeWorktreeTopologyChanges, observeWorktreeTopology } = worktreeTopologyService;
const publishWorktreeTopologyChange = worktreeTopologyService.publishWorktreeTopologyChange;

// Bootstrap state has one owner. Creation and removal receive the same
// operations, so neither duplicates the maps or the persisted-state rules.
const worktreeBootstrapStateService = createWorktreeBootstrapStateService({
  fsp, path, process, normalizeDirectoryPath, canonicalPath, runGitCommand,
});
const {
  setWorktreeBootstrapState, trackWorktreeBootstrapTask, getRecordedBootstrapPhase,
  waitForActiveWorktreeBootstrap, clearWorktreeBootstrapState,
} = worktreeBootstrapStateService;
export const { getWorktreeBootstrapStatus, completeWorktreeCheckoutHydration } = worktreeBootstrapStateService;

// Creation and population reference each other: creation runs the population
// reset during bootstrap, and population's checkout-trust inspection reads the
// project start command creation owns. Population is composed second, so
// creation receives a forwarder that resolves it at call time; the module
// dependency itself stays one-way.
let worktreePopulationService = null;
const worktreeCreationService = createWorktreeCreationService({
  fsp, path, os, process, console, execFileAsync,
  normalizeDirectoryPath, normalizeGitOutputPath, readWorktreeDirectorySetting,
  runGitCommand, runGitCommandOrThrow, buildGitEnv,
  cleanBranchName, normalizeStartRef, parseRemoteBranchRef, resolveRemoteBranchRef,
  resolveCheckoutRemoteName, normalizeUpstreamTarget, parseGitErrorText,
  checkPathExists, isInsideOrSameDirectory, parseWorktreePorcelain,
  populateWorktreeWithLockRecovery: (...args) => worktreePopulationService.populateWorktreeWithLockRecovery(...args),
  isFilenameTooLongError, formatWorktreePopulateError,
  fingerprintRemoteUrl, getStatus, publishWorktreeTopologyChange,
  setWorktreeBootstrapState, trackWorktreeBootstrapTask, getRecordedBootstrapPhase,
});
export const { validateWorktreeCreate, previewWorktreeCreate, createWorktree } = worktreeCreationService;
const { resolveWorktreeProjectContext, listWorktreeEntries, loadProjectStartCommand } = worktreeCreationService;

worktreePopulationService = createWorktreePopulationService({
  fsp, fs, path, crypto,
  normalizeDirectoryPath, normalizeGitOutputPath,
  runGitCommand, runGitCommandOrThrow, buildGitEnv,
  getFileIdentity, wait,
  loadProjectStartCommand,
});
export const { ensureWorktreeLongpaths, populateWorktreeWithLockRecovery, inspectContributorCheckoutActions } = worktreePopulationService;

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
