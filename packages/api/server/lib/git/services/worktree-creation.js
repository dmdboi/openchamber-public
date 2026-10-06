// Worktree creation and bootstrap orchestration: project context, candidate
// resolution, validation/preview, remote provisioning and rollback, start
// scripts, and the background bootstrap task. Bootstrap state itself is owned
// by `worktree-bootstrap-state.js` and injected here by service.js.

import {
  WORKTREE_BOOTSTRAP_PENDING,
  WORKTREE_BOOTSTRAP_READY,
  WORKTREE_BOOTSTRAP_FAILED,
  WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED,
  WORKTREE_BOOTSTRAP_PHASE_GIT_READY,
  WORKTREE_BOOTSTRAP_PHASE_SETUP_READY,
} from './worktree-bootstrap-state.js';

export function createWorktreeCreationService({
  fsp, path, os, process, console, execFileAsync,
  normalizeDirectoryPath, normalizeGitOutputPath, readWorktreeDirectorySetting,
  runGitCommand, runGitCommandOrThrow, buildGitEnv,
  cleanBranchName, normalizeStartRef, parseRemoteBranchRef, resolveRemoteBranchRef,
  resolveCheckoutRemoteName, normalizeUpstreamTarget, parseGitErrorText,
  checkPathExists, isInsideOrSameDirectory, parseWorktreePorcelain,
  populateWorktreeWithLockRecovery, isFilenameTooLongError, formatWorktreePopulateError,
  fingerprintRemoteUrl, getStatus, publishWorktreeTopologyChange,
  setWorktreeBootstrapState, trackWorktreeBootstrapTask, getRecordedBootstrapPhase,
}) {
  const remoteProvisioningQueues = new Map();

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
      const recordedPhase = await getRecordedBootstrapPhase(directory);
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
async function validateWorktreeCreate(directory, input = {}) {
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

async function previewWorktreeCreate(directory, input = {}) {
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

async function createWorktree(directory, input = {}, serverOptions = {}) {
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

  return {
    resolveWorktreeProjectContext,
    listWorktreeEntries,
    loadProjectStartCommand,
    validateWorktreeCreate,
    previewWorktreeCreate,
    createWorktree,
  };
}
