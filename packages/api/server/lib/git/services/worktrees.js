import fs from 'node:fs';
import path from 'node:path';

export function createWorktreeService({
    createGit,
    isNotGitRepositoryError,
    normalizeDirectoryPath,
    normalizeGitOutputPath,
    parseWorktreePorcelain,
    resolveGitRepositoryRoot,
    runGitCommand,
    runGitCommandOrThrow,
  }) {
  async function getWorktrees(directory) {
    const directoryPath = normalizeDirectoryPath(directory);
    if (!directoryPath || !fs.existsSync(directoryPath)) {
      return [];
    }
    try {
      const directoryGit = await createGit(directoryPath);
      const repoRoot = await resolveGitRepositoryRoot(directoryPath, directoryGit);
      const result = await runGitCommandOrThrow(
        repoRoot,
        ['worktree', 'list', '--porcelain'],
        'Failed to list git worktrees'
      );
      return parseWorktreePorcelain(result.stdout).map((entry) => ({
        head: entry.head || '',
        name: path.basename(entry.worktree || ''),
        branch: entry.branch || '',
        path: entry.worktree,
        prunable: entry.prunable === true,
      }));
    } catch (error) {
      // Worktrees are an optional feature. When the caller passes a directory
      // that is not inside any git repository (for example, the managed
      // OpenCode's working directory or an unconfigured project path), git
      // exits with "fatal: not a git repository ...". Treat that as an
      // authoritative empty result so the route handler can still respond
      // 200 [] and the desktop main.log stays free of noise. Any other failure
      // is a failure: callers keep their last known topology instead of
      // treating "git could not answer" as "there are no worktrees".
      if (isNotGitRepositoryError(error)) return [];
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Worktree topology change tracking
  //
  // Linked worktrees are registered under the repository's common Git directory
  // (`<common>/worktrees/<name>`). Instead of watching the filesystem, the server
  // fingerprints that directory while handling requests clients already make
  // (status, worktree listing) and after its own worktree create/remove, and
  // tells connected clients when the set of worktrees changed. Cost scales with
  // user activity, never with the number of registered projects.
  // ---------------------------------------------------------------------------

  const MAX_TRACKED_WORKTREE_DIRECTORIES = 500;
  const MAX_TRACKED_WORKTREE_REPOSITORIES = 200;
  const MAX_DIRECTORIES_PER_WORKTREE_REPOSITORY = 100;
  const worktreeTopologyListeners = new Set();
  const worktreeRepositoryKeyByDirectory = new Map();
  const worktreeTopologyByRepository = new Map();

  function subscribeWorktreeTopologyChanges(listener) {
    worktreeTopologyListeners.add(listener);
    return () => {
      worktreeTopologyListeners.delete(listener);
    };
  }

  const rememberWorktreeRepositoryKey = (directoryPath, key) => {
    worktreeRepositoryKeyByDirectory.delete(directoryPath);
    worktreeRepositoryKeyByDirectory.set(directoryPath, key);
    while (worktreeRepositoryKeyByDirectory.size > MAX_TRACKED_WORKTREE_DIRECTORIES) {
      const oldest = worktreeRepositoryKeyByDirectory.keys().next().value;
      if (oldest === undefined) break;
      worktreeRepositoryKeyByDirectory.delete(oldest);
    }
  };

  /**
   * Canonical common Git directory for `directoryPath`, resolved with git once per
   * directory and cached. Returns null when git cannot answer (not a repository,
   * missing directory).
   */
  const resolveWorktreeRepositoryKey = async (directoryPath) => {
    const cached = worktreeRepositoryKeyByDirectory.get(directoryPath);
    if (cached) {
      rememberWorktreeRepositoryKey(directoryPath, cached);
      return cached;
    }
    const result = await runGitCommand(directoryPath, ['rev-parse', '--git-common-dir']);
    const rawCommonDir = String(result.stdout || '').trim();
    if (!result.success || !rawCommonDir) {
      return null;
    }
    const commonDir = path.resolve(directoryPath, rawCommonDir);
    let key = commonDir;
    try {
      key = fs.realpathSync(commonDir);
    } catch {
      // Keep the resolved path; a missing common dir cannot register worktrees.
    }
    rememberWorktreeRepositoryKey(directoryPath, key);
    return key;
  };

  /**
   * Cheap identity of the registered linked-worktree set: the `worktrees`
   * directory's mtime plus its entry names. Adding, removing, or pruning a
   * worktree changes at least one of them; `git worktree move` rewrites files
   * inside an entry and is not detected.
   */
  const readWorktreeTopologyFingerprint = (repositoryKey) => {
    const worktreesDir = path.join(repositoryKey, 'worktrees');
    try {
      const stat = fs.statSync(worktreesDir);
      const names = fs.readdirSync(worktreesDir).sort();
      return `${stat.mtimeMs}:${names.join('\0')}`;
    } catch {
      return 'none';
    }
  };

  const trackWorktreeTopologyDirectory = (repositoryKey, directoryPath) => {
    let entry = worktreeTopologyByRepository.get(repositoryKey);
    if (!entry) {
      entry = { directories: new Set(), fingerprint: null };
    }
    // Re-insert so the map stays ordered by last use; the least recently used
    // repository is dropped first once the bound is reached.
    worktreeTopologyByRepository.delete(repositoryKey);
    worktreeTopologyByRepository.set(repositoryKey, entry);
    while (worktreeTopologyByRepository.size > MAX_TRACKED_WORKTREE_REPOSITORIES) {
      const oldest = worktreeTopologyByRepository.keys().next().value;
      if (oldest === undefined) break;
      worktreeTopologyByRepository.delete(oldest);
    }
    if (entry.directories.size < MAX_DIRECTORIES_PER_WORKTREE_REPOSITORY) {
      entry.directories.add(directoryPath);
    }
    return entry;
  };

  const notifyWorktreeTopologyChanged = (entry) => {
    const event = { directories: [...entry.directories], at: Date.now() };
    for (const listener of worktreeTopologyListeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn('Worktree topology listener failed:', error?.message || error);
      }
    }
  };

  /**
   * Compare the repository's worktree set with the last one seen for it and
   * notify listeners when it changed. The first observation only records a
   * baseline. Called from request handlers that already touch the repository;
   * never throws.
   */
  async function observeWorktreeTopology(directory) {
    const directoryPath = normalizeDirectoryPath(directory);
    if (!directoryPath) return;
    try {
      const repositoryKey = await resolveWorktreeRepositoryKey(directoryPath);
      if (!repositoryKey) return;
      const entry = trackWorktreeTopologyDirectory(repositoryKey, directoryPath);
      const fingerprint = readWorktreeTopologyFingerprint(repositoryKey);
      if (entry.fingerprint === fingerprint) return;
      const hadBaseline = entry.fingerprint !== null;
      entry.fingerprint = fingerprint;
      if (hadBaseline) notifyWorktreeTopologyChanged(entry);
    } catch (error) {
      console.warn('Failed to observe worktree topology:', error?.message || error);
    }
  }

  /**
   * Record that this server changed the repository's worktree set itself and
   * notify listeners right away. `directory` is any directory inside the
   * repository; never throws so a notification problem cannot fail the
   * operation that triggered it.
   */
  const publishWorktreeTopologyChange = async (directory) => {
    const directoryPath = normalizeDirectoryPath(directory);
    if (!directoryPath) return;
    try {
      const repositoryKey = await resolveWorktreeRepositoryKey(directoryPath);
      if (!repositoryKey) return;
      const entry = trackWorktreeTopologyDirectory(repositoryKey, directoryPath);
      entry.fingerprint = readWorktreeTopologyFingerprint(repositoryKey);
      notifyWorktreeTopologyChanged(entry);
    } catch (error) {
      console.warn('Failed to publish worktree topology change:', error?.message || error);
    }
  };


  return { getWorktrees, subscribeWorktreeTopologyChanges, observeWorktreeTopology, publishWorktreeTopologyChange };
}
