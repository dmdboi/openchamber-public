// Worktree population owns three things: enabling `core.longpaths` for the deep
// managed checkout root, materializing a worktree with a filter- and
// hook-neutral reset that recovers from stale `index.lock` files, and
// inspecting the executable content a contributor checkout would run so trust
// can be bound to its exact bytes and invocation path.
//
// `service.js` composes this service. `loadProjectStartCommand` is injected
// from the worktree-creation service: creation needs this module's
// `populateWorktreeWithLockRecovery`, so the dependency only goes one way and
// neither module imports the other.

const GIT_NULL_REF = '0'.repeat(40);
const WORKTREE_INDEX_LOCK_RETRY_DELAY_MS = 250;
const WORKTREE_INDEX_LOCK_STALE_DELAY_MS = 750;

export const isFilenameTooLongError = (message) => /file ?name too long/i.test(String(message || ''));

export const formatWorktreePopulateError = (message) => {
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

export function createWorktreePopulationService({
  fsp, fs, path, crypto,
  normalizeDirectoryPath, normalizeGitOutputPath,
  runGitCommand, runGitCommandOrThrow, buildGitEnv,
  getFileIdentity, wait,
  loadProjectStartCommand,
}) {
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

  const ensureWorktreeLongpaths = async (directory) => {
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

  const populateWorktreeWithLockRecovery = async (directory) => {
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

  const inspectContributorCheckoutActions = async (directory, provenance) => {
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

  return {
    ensureWorktreeLongpaths,
    populateWorktreeWithLockRecovery,
    inspectContributorCheckoutActions,
  };
}
