// Single owner of process-local worktree bootstrap state and the registry of
// active bootstrap tasks. Creation and removal both receive these operations
// from service.js, so neither duplicates the maps or the persisted-state rules.
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const WORKTREE_BOOTSTRAP_PENDING = 'pending';
export const WORKTREE_BOOTSTRAP_READY = 'ready';
export const WORKTREE_BOOTSTRAP_FAILED = 'failed';
export const WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED = 'directory-created';
export const WORKTREE_BOOTSTRAP_PHASE_GIT_READY = 'git-ready';
export const WORKTREE_BOOTSTRAP_PHASE_SETUP_READY = 'setup-ready';
export const WORKTREE_BOOTSTRAP_RECOVERY_ERROR = 'Worktree bootstrap completion is unknown. Inspect the checkout and repair setup before use.';

export function createWorktreeBootstrapStateService({
  normalizeDirectoryPath, canonicalPath, runGitCommand,
}) {
  const worktreeBootstrapState = new Map();
  const activeWorktreeBootstrapTasks = new Map();

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

async function getWorktreeBootstrapStatus(directory, { bootstrapStore } = {}) {
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

async function completeWorktreeCheckoutHydration(directory, { bootstrapStore } = {}) {
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

  const getRecordedBootstrapPhase = async (directory) => {
    const key = await toCanonicalBootstrapStateKey(directory);
    if (!key) {
      return undefined;
    }
    return worktreeBootstrapState.get(key)?.phase;
  };

  return {
    createWorktreeBootstrapState,
    setWorktreeBootstrapState,
    clearWorktreeBootstrapState,
    trackWorktreeBootstrapTask,
    waitForActiveWorktreeBootstrap,
    hasActiveWorktreeBootstrap,
    getRecordedBootstrapPhase,
    getWorktreeBootstrapStatus,
    completeWorktreeCheckoutHydration,
  };
}
