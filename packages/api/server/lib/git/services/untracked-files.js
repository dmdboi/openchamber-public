import { spawn } from 'node:child_process';

const UNTRACKED_DIRECTORY_EXPANSION_LIMIT = 1000;
const GIT_UNTRACKED_LISTING_STALL_TIMEOUT_MS = 60_000;

export function createUntrackedFilesService({
  buildGitEnv,
  getGitBinary,
  platform = process.platform,
  spawnProcess = spawn,
}) {
  const killProcessTree = (child) => {
    if (!child.pid) return;
    if (platform === 'win32') {
      try {
        spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      } catch {
        child.kill('SIGKILL');
      }
      return;
    }
    child.kill('SIGKILL');
  };

  const listUntrackedFilesBounded = async (repoRoot, dirPath, limit) => {
    const env = await buildGitEnv();
    return new Promise((resolve, reject) => {
      const child = spawnProcess(getGitBinary(), ['ls-files', '--others', '--exclude-standard', '-z', '--', dirPath], {
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

  return { expandUntrackedDirectories };
}
