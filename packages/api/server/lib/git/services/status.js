import { createSerialRefresh } from '../serial-refresh.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function createStatusService({
  buildGitEnv,
  createRepositoryGitContext,
  getGitBinary,
  hasRemote,
  isGitRepository,
  isMissingDirectoryError,
  isNotGitRepositoryError,
  normalizeDirectoryPath,
  resolveGitInternalPath,
  runGitCommand,
  getRemoteBranchComparison,
}) {
  const fsp = fs.promises;
  // Beyond this many untracked files, a directory stays one `dir/` entry in
  // status. Every file would otherwise become a row, a diff request, and a stat
  // on the server, and the only directories that large are ones that belong in
  // .gitignore.
  const UNTRACKED_DIRECTORY_EXPANSION_LIMIT = 1000;

  // A status read holds one of MAX_CONCURRENT_STATUS_READS slots until it
  // finishes. Git never gets a terminal here, but a process can still hang on
  // Windows (a locked index, a stuck filesystem monitor, an unreachable network
  // drive), and a hung process would hold its slot forever: four of them and no
  // status read runs again until someone kills them by hand. Every process the
  // read spawns is therefore killed when it stops producing output for this long,
  // and the read fails instead of wedging the limiter. Two minutes is far above
  // what a healthy read spends silent, even on a very large tree.
  const GIT_STATUS_STALL_TIMEOUT_MS = 120_000;
  const GIT_UNTRACKED_LISTING_STALL_TIMEOUT_MS = 60_000;
  const GIT_PROBE_TIMEOUT_MS = 30_000;

  // Untracked files under `dirPath` (repository-relative, trailing slash), read
  // Git for Windows runs commands through a launcher: the `git.exe` we spawn is a
  // wrapper whose child is the real `git`. Killing only the wrapper leaves that
  // child alive, still walking the tree on its own (a repository rooted at a
  // drive root sends it through Program Files), and it shows up in Task Manager
  // as a stuck pair until someone ends it by hand. Windows has no process groups
  // to signal, so the tree is ended through taskkill.
  const killProcessTree = (child) => {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      } catch {
        child.kill('SIGKILL');
      }
      return;
    }
    child.kill('SIGKILL');
  };

  // from a streamed `ls-files` that is stopped once the bound is exceeded so a
  // huge directory is never listed in full. `paths` is complete when
  // `truncated` is false.
  const listUntrackedFilesBounded = async (repoRoot, dirPath, limit) => {
    const env = await buildGitEnv();
    return new Promise((resolve, reject) => {
      const child = spawn(getGitBinary(), ['ls-files', '--others', '--exclude-standard', '-z', '--', dirPath], {
        cwd: repoRoot,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const paths = [];
      let pending = '';
      let truncated = false;
      let settled = false;
      let stallTimer = null;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (stallTimer) clearTimeout(stallTimer);
        if (error) {
          reject(error);
          return;
        }
        resolve({ paths, truncated });
      };
      // A listing that goes silent is killed rather than left holding the
      // status read (and its limiter slot) open.
      const armStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          killProcessTree(child);
          finish(new Error(`git ls-files produced no output for ${GIT_UNTRACKED_LISTING_STALL_TIMEOUT_MS}ms in ${dirPath}`));
        }, GIT_UNTRACKED_LISTING_STALL_TIMEOUT_MS);
      };
      armStallTimer();
      child.stdout.on('data', (chunk) => {
        armStallTimer();
        if (truncated) return;
        pending += chunk.toString('utf8');
        const records = pending.split('\0');
        pending = records.pop() ?? '';
        for (const record of records) {
          if (!record) continue;
          paths.push(record);
          if (paths.length > limit) {
            truncated = true;
            killProcessTree(child);
            finish();
            return;
          }
        }
      });
      child.on('error', (error) => finish(error));
      child.on('close', (code) => {
        if (truncated) {
          finish();
          return;
        }
        if (code !== 0) {
          finish(new Error(`git ls-files exited with code ${code} for ${dirPath}`));
          return;
        }
        if (pending) paths.push(pending);
        finish();
      });
    });
  };

  // Replaces each untracked `dir/` entry from `-unormal` with one entry per file
  // inside it, the listing `-uall` would have produced, unless the directory
  // holds more than the bound; then the `dir/` entry stays. A nested repository
  // lists as itself and stays a `dir/` entry too, which is what the diff routes
  // expect. A listing failure keeps the `dir/` entry rather than dropping the
  // change from the status.
  const expandUntrackedDirectories = async (repoRoot, files) => {
    const expanded = [];
    for (const file of files) {
      const isUntrackedDirectory = file.path.endsWith('/')
        && (file.working_dir || '').trim() === '?'
        && (file.index || '').trim() === '?';
      if (!isUntrackedDirectory) {
        expanded.push(file);
        continue;
      }
      const listing = await listUntrackedFilesBounded(repoRoot, file.path, UNTRACKED_DIRECTORY_EXPANSION_LIMIT)
        .catch((error) => {
          console.warn(`[GitService] Could not expand untracked directory ${file.path}:`, error?.message || error);
          return null;
        });
      if (!listing || listing.truncated || listing.paths.some((entry) => entry === file.path)) {
        expanded.push(file);
        continue;
      }
      for (const entryPath of listing.paths) {
        expanded.push({ ...file, path: entryPath });
      }
    }
    return expanded;
  };

  // A status read walks the working tree and runs a dozen Git processes; on a
  // large repository it takes seconds. Clients ask for it after every completed
  // agent tool call, from several surfaces, and from PR polling, so without a
  // bound one slow repository ends up with many identical `git status` processes
  // side by side. Runs are serialized per directory and capped across
  // directories; a caller that asks during a run gets a run started after it
  // asked, so results are never older than the request.
  const MAX_CONCURRENT_STATUS_READS = 4;
  const statusRefresh = createSerialRefresh({ maxConcurrent: MAX_CONCURRENT_STATUS_READS });

  async function getStatus(directory, options = {}) {
    const normalizedDirectory = normalizeDirectoryPath(directory);
    if (!normalizedDirectory || !normalizedDirectory.trim()) {
      throw new Error('directory is required');
    }
    const lightMode = options.mode === 'light';
    // A full read satisfies light callers too, so one run serves whichever
    // callers it answers, at the widest mode any of them asked for.
    return statusRefresh.run(
      normalizedDirectory,
      { lightMode },
      (requests) => readStatus(normalizedDirectory, requests.every((request) => request.lightMode)),
    );
  }

  /**
   * Upstream of the checked-out branch as `remote/branch`, or `null` when HEAD
   * is detached, unborn, or the branch has no upstream configured. Reads refs
   * and config only, never the working tree: callers that only need the
   * tracking name must not pay for a status read.
   */
  async function getTrackingBranch(directory) {
    const normalizedDirectory = normalizeDirectoryPath(directory);
    if (!normalizedDirectory) {
      return null;
    }
    const head = await runGitCommand(normalizedDirectory, ['symbolic-ref', '--quiet', 'HEAD']);
    const headRef = head.success ? head.stdout.trim() : '';
    if (!headRef.startsWith('refs/heads/')) {
      return null;
    }
    const upstream = await runGitCommand(normalizedDirectory, ['for-each-ref', '--format=%(upstream:short)', headRef]);
    const tracking = upstream.success ? upstream.stdout.trim() : '';
    return tracking || null;
  }

  async function readStatus(normalizedDirectory, lightMode) {
    try {
      // Prefer an explicit non-repo check before simple-git status so a missing
      // repository never depends on process.cwd() or an opaque GitError shape.
      if (!(await isGitRepository(normalizedDirectory))) {
        throw new Error('fatal: not a git repository (or any of the parent directories): .git');
      }

      const { directoryPath, repoRoot, git } = await createRepositoryGitContext(normalizedDirectory, {
        stallTimeoutMs: GIT_STATUS_STALL_TIMEOUT_MS,
      });

      // `-unormal` lists a directory with no tracked files as one `dir/` entry
      // and stops walking it at its first file. `-uall` would walk every file
      // in it: on a forgotten build or dependency directory that is a scan of
      // tens of thousands of files and hundreds of megabytes per status read.
      // Directories are expanded to their files afterwards, up to a bound.
      const status = await git.status(['-unormal']);
      status.files = await expandUntrackedDirectories(repoRoot, status.files);

      // Light mode: skip numstat + new-file line counting for faster response.
      // Staged (`--cached`: HEAD -> index) and working (`--numstat`: index -> worktree)
      // stay in separate maps. A partially staged file has an entry in both, and the
      // UI shows each row's own scope instead of a combined total.
      const [stagedStatsRaw, workingStatsRaw] = lightMode
        ? ['', '']
        : await Promise.all([
            git.raw(['diff', '--cached', '--numstat']).catch(() => ''),
            git.raw(['diff', '--numstat']).catch(() => ''),
          ]);

      const stagedDiffStats = {};
      const workingDiffStats = {};

      const accumulateStats = (raw, target) => {
        if (!raw) return;
        raw
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach((line) => {
            const parts = line.split('\t');
            if (parts.length < 3) {
              return;
            }
            const [insertionsRaw, deletionsRaw, ...pathParts] = parts;
            const path = pathParts.join('\t');
            if (!path) {
              return;
            }
            const insertions = insertionsRaw === '-' ? 0 : parseInt(insertionsRaw, 10) || 0;
            const deletions = deletionsRaw === '-' ? 0 : parseInt(deletionsRaw, 10) || 0;

            const existing = target[path] || { insertions: 0, deletions: 0 };
            target[path] = {
              insertions: existing.insertions + insertions,
              deletions: existing.deletions + deletions,
            };
          });
      };

      accumulateStats(stagedStatsRaw, stagedDiffStats);
      accumulateStats(workingStatsRaw, workingDiffStats);

      const diffStats = { staged: stagedDiffStats, working: workingDiffStats };

      const MAX_NEW_FILE_STATS = 200;
      const MAX_NEW_FILE_STAT_SIZE = 1024 * 1024;
      const newFileStats = [];

      if (!lightMode) {
        for (const file of status.files) {
          if (newFileStats.length >= MAX_NEW_FILE_STATS) {
            break;
          }

          const working = (file.working_dir || '').trim();
          const indexStatus = (file.index || '').trim();
          const statusCode = working || indexStatus;

          if (statusCode !== '?' && statusCode !== 'A') {
            continue;
          }

          // Untracked and working-tree-added files belong to the working scope;
          // a file whose 'A' code is on the index belongs to the staged scope.
          const target = working === '?' || working === 'A' ? workingDiffStats : stagedDiffStats;
          const existing = target[file.path];
          if (existing && existing.insertions > 0) {
            continue;
          }

          const absolutePath = path.join(repoRoot, file.path);

          try {
            const stat = await fsp.stat(absolutePath);
            if (!stat.isFile() || stat.size > MAX_NEW_FILE_STAT_SIZE) {
              continue;
            }

            const buffer = await fsp.readFile(absolutePath);
            if (buffer.indexOf(0) !== -1) {
              newFileStats.push({
                target,
                path: file.path,
                insertions: existing?.insertions ?? 0,
                deletions: existing?.deletions ?? 0,
              });
              continue;
            }

            const normalized = buffer.toString('utf8').replace(/\r\n/g, '\n');
            if (!normalized.length) {
              newFileStats.push({
                target,
                path: file.path,
                insertions: 0,
                deletions: 0,
              });
              continue;
            }

            const segments = normalized.split('\n');
            if (normalized.endsWith('\n')) {
              segments.pop();
            }

            const lineCount = segments.length;
            newFileStats.push({
              target,
              path: file.path,
              insertions: lineCount,
              deletions: 0,
            });
          } catch (error) {
            if (error?.code !== 'ENOENT') {
              console.warn('Failed to estimate diff stats for new file', file.path, error);
            }
          }
        }
      }

      for (const entry of newFileStats) {
        entry.target[entry.path] = {
          insertions: entry.insertions,
          deletions: entry.deletions,
        };
      }

      const selectBaseRefForUnpublished = async () => {
        const candidates = [];

        const originHead = await git
          .raw(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'])
          .then((value) => String(value || '').trim())
          .catch(() => '');

        if (originHead) {
          // "refs/remotes/origin/main" -> "origin/main"
          candidates.push(originHead.replace(/^refs\/remotes\//, ''));
        }

        candidates.push('origin/main', 'origin/master', 'main', 'master');

        for (const ref of candidates) {
          // A branch compared with itself always reads 0 commits ahead, which
          // would let a never-pushed `main` pass as having nothing unpublished.
          if (ref === status.current) continue;
          const exists = await git
            .raw(['rev-parse', '--verify', ref])
            .then((value) => String(value || '').trim())
            .catch(() => '');
          if (exists) return ref;
        }

        return null;
      };

      let tracking = status.tracking || null;
      let ahead = status.ahead;
      let behind = status.behind;
      // The ref `ahead` was counted against when there is no upstream; null when
      // that count was not made, so a bare 0 never reads as "nothing unpublished".
      let aheadBase = null;
      let upstreamComparison;

      // When no upstream is configured (common for new worktree branches), Git doesn't report ahead/behind.
      // We still want to show the number of unpublished commits to the user.
      // Light mode skips this — the basic ahead/behind from git status is sufficient for polling.
      if (!lightMode && !tracking && status.current) {
        const baseRef = await selectBaseRefForUnpublished();
        if (baseRef) {
          const countRaw = await git
            .raw(['rev-list', '--count', `${baseRef}..HEAD`])
            .then((value) => String(value || '').trim())
            .catch(() => '');
          const count = parseInt(countRaw, 10);
          if (Number.isFinite(count)) {
            ahead = count;
            behind = 0;
            aheadBase = baseRef;
          }
        }
      }

      if (
        !lightMode
        && status.current
        && (!tracking || !tracking.startsWith('upstream/'))
        && await hasRemote(git, directoryPath, 'upstream')
      ) {
        upstreamComparison = await getRemoteBranchComparison(git, 'upstream', status.current);
      }

      // Check for in-progress operations
      let mergeInProgress = null;
      let rebaseInProgress = null;

      try {
        // Check MERGE_HEAD for merge in progress
        const mergeHeadExists = await git
          .raw(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
          .then(() => true)
          .catch(() => false);

        if (mergeHeadExists) {
          const mergeHead = await git.raw(['rev-parse', 'MERGE_HEAD']).catch(() => '');
          const headSha = mergeHead.trim().slice(0, 7);
          // Only set mergeInProgress if we actually have a valid head SHA
          if (headSha) {
            const mergeMsgPath = await resolveGitInternalPath(repoRoot, git, 'MERGE_MSG').catch(() => '');
            const mergeMsg = mergeMsgPath ? await fsp.readFile(mergeMsgPath, 'utf8').catch(() => '') : '';
            mergeInProgress = {
              head: headSha,
              message: mergeMsg.split('\n')[0] || '',
            };
          }
        }
      } catch {
        // ignore
      }

      try {
        // Check for rebase in progress (.git/rebase-merge or .git/rebase-apply)
        const rebaseMergePath = await resolveGitInternalPath(repoRoot, git, 'rebase-merge').catch(() => '');
        const rebaseApplyPath = await resolveGitInternalPath(repoRoot, git, 'rebase-apply').catch(() => '');
        const rebaseMergeExists = rebaseMergePath ? await fsp.stat(rebaseMergePath).then(() => true).catch(() => false) : false;
        const rebaseApplyExists = rebaseApplyPath ? await fsp.stat(rebaseApplyPath).then(() => true).catch(() => false) : false;

        if (rebaseMergeExists || rebaseApplyExists) {
          const rebasePath = rebaseMergeExists ? rebaseMergePath : rebaseApplyPath;
          const headName = await fsp.readFile(path.join(rebasePath, 'head-name'), 'utf8').catch(() => '');
          const onto = await fsp.readFile(path.join(rebasePath, 'onto'), 'utf8').catch(() => '');

          const headNameTrimmed = headName.trim().replace('refs/heads/', '');
          const ontoTrimmed = onto.trim().slice(0, 7);

          // Only set rebaseInProgress if we have valid data
          if (headNameTrimmed || ontoTrimmed) {
            rebaseInProgress = {
              headName: headNameTrimmed,
              onto: ontoTrimmed,
            };
          }
        }
      } catch {
        // ignore
      }

      return {
        current: status.current,
        tracking,
        ahead,
        behind,
        aheadBase,
        upstreamComparison,
        files: status.files.map((f) => ({
          path: f.path,
          index: f.index,
          working_dir: f.working_dir,
        })),
        isClean: status.isClean(),
        diffStats: lightMode ? undefined : diffStats,
        mergeInProgress,
        rebaseInProgress,
      };
    } catch (error) {
      if (isNotGitRepositoryError(error) || isMissingDirectoryError(error)) {
        // Re-throw a plain Error so route/session callers can match reliably and
        // continue enumerating other projects instead of treating GitError as 500.
        throw new Error('fatal: not a git repository (or any of the parent directories): .git');
      }
      console.error('Failed to get Git status:', error);
      throw error;
    }
  }

    return { getStatus, getTrackingBranch };
}
