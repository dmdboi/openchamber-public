export function createIntegrateService({ runGitCommand, runGitCommandOrThrow, normalizeDirectoryPath, path, os, fsp }) {
  const trimGitLines = (value) => String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const gitStdoutText = (result) => String(result?.stdout || '').trim();
  const gitStderrText = (result) => String(result?.stderr || result?.message || '').trim();

  const normalizeIntegrateBranch = (value, fieldName) => {
    const branch = String(value || '').trim();
    if (!branch) {
      throw new Error(`${fieldName} is required`);
    }
    if (branch.startsWith('-') || branch.includes('\0')) {
      throw new Error(`Invalid ${fieldName}`);
    }
    return branch;
  };

  const normalizeIntegrateSha = (value) => {
    const sha = String(value || '').trim();
    if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) {
      throw new Error('Invalid commit SHA');
    }
    return sha;
  };

  const normalizeIntegratePath = (value, fieldName) => {
    const target = normalizeDirectoryPath(value);
    if (!target) {
      throw new Error(`${fieldName} is required`);
    }
    return path.resolve(target);
  };

  const runGitOk = (result) => Boolean(result?.success);

  const listGitWorktreesForIntegrate = async (repoRoot) => {
    const out = await runGitCommandOrThrow(repoRoot, ['worktree', 'list', '--porcelain'], 'Failed to list git worktrees');
    const entries = [];
    let current = null;
    for (const line of String(out.stdout || '').split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        if (current) entries.push(current);
        current = { path: line.slice('worktree '.length).trim(), branchRef: null };
        continue;
      }
      if (!current) continue;
      if (line.startsWith('branch ')) {
        current.branchRef = line.slice('branch '.length).trim();
      }
    }
    if (current) entries.push(current);
    return entries.filter((entry) => Boolean(entry.path));
  };

  const ensureLocalIntegrateBranch = async (repoRoot, candidate) => {
    const raw = normalizeIntegrateBranch(candidate, 'targetBranch');
    if (raw === 'HEAD') {
      return 'HEAD';
    }

    const hasLocal = await runGitCommand(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${raw}`]);
    if (runGitOk(hasLocal)) {
      return raw;
    }

    if (raw.startsWith('remotes/')) {
      const remoteRef = raw.slice('remotes/'.length);
      const parts = remoteRef.split('/');
      const remote = normalizeIntegrateBranch(parts[0] || 'origin', 'remote');
      const name = normalizeIntegrateBranch(parts.slice(1).join('/'), 'branch');
      await runGitCommandOrThrow(repoRoot, ['branch', '--track', name, `${remote}/${name}`], 'Failed to track remote branch');
      return name;
    }

    const remoteCheck = await runGitCommand(repoRoot, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${raw}`]);
    if (runGitOk(remoteCheck)) {
      await runGitCommandOrThrow(repoRoot, ['branch', '--track', raw, `origin/${raw}`], 'Failed to track remote branch');
      return raw;
    }

    return raw;
  };

  /** @public */
  async function computeIntegratePlan(input = {}) {
    const repoRoot = normalizeIntegratePath(input.repoRoot, 'repoRoot');
    const sourceBranch = normalizeIntegrateBranch(input.sourceBranch, 'sourceBranch');
    const targetBranchRaw = normalizeIntegrateBranch(input.targetBranch, 'targetBranch');
    if (sourceBranch === 'HEAD' || targetBranchRaw === 'HEAD') {
      return { repoRoot, sourceBranch, targetBranch: targetBranchRaw, commits: [] };
    }

    const targetBranch = await ensureLocalIntegrateBranch(repoRoot, targetBranchRaw);
    const cherry = await runGitCommandOrThrow(repoRoot, ['cherry', targetBranch, sourceBranch], 'Failed to compute cherry commits');
    const plus = new Set();
    for (const line of trimGitLines(cherry.stdout)) {
      const match = line.match(/^\+\s+([0-9a-f]{7,40})\b/i);
      if (match) {
        plus.add(match[1]);
      }
    }

    const revList = await runGitCommandOrThrow(repoRoot, ['rev-list', '--reverse', `${targetBranch}..${sourceBranch}`], 'Failed to list commits');
    const commits = trimGitLines(revList.stdout).filter((sha) => plus.has(sha));
    return { repoRoot, sourceBranch, targetBranch, commits };
  }

  const createIntegrateTempWorktree = async (repoRoot, targetBranch) => {
    const tmpParent = path.join(os.homedir(), '.config', 'openchamber', 'tmp');
    await fsp.mkdir(tmpParent, { recursive: true });
    const tmpDir = await fsp.mkdtemp(path.join(tmpParent, 'oc-integrate-'));
    try {
      await runGitCommandOrThrow(repoRoot, ['worktree', 'add', '--force', tmpDir, targetBranch], 'Failed to create temp worktree');
      return tmpDir;
    } catch (error) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  };

  const removeIntegrateTempWorktree = async (repoRoot, tmpDir) => {
    await runGitCommand(repoRoot, ['worktree', 'remove', '--force', tmpDir]).catch(() => undefined);
    await runGitCommand(repoRoot, ['worktree', 'prune']).catch(() => undefined);
  };

  const maybeFastForwardIntegrateUpstream = async (tmpDir) => {
    const upstream = await runGitCommand(tmpDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    const upstreamRef = gitStdoutText(upstream);
    if (!upstreamRef) {
      return;
    }
    const ff = await runGitCommand(tmpDir, ['merge', '--ff-only', upstreamRef]);
    if (!runGitOk(ff)) {
      throw new Error(gitStderrText(ff) || 'Fast-forward failed');
    }
  };

  /** @public */
  async function getIntegrateConflictDetails(tmpDir) {
    const target = normalizeIntegratePath(tmpDir, 'tempWorktreePath');
    const [status, unmerged, diff, meta, patch] = await Promise.all([
      runGitCommand(target, ['status', '--porcelain']),
      runGitCommand(target, ['diff', '--name-only', '--diff-filter=U']),
      runGitCommand(target, ['diff']),
      runGitCommand(target, ['show', '--no-patch', '--pretty=fuller', 'CHERRY_PICK_HEAD']),
      runGitCommand(target, ['show', 'CHERRY_PICK_HEAD']),
    ]);

    return {
      statusPorcelain: String(status.stdout || ''),
      unmergedFiles: trimGitLines(unmerged.stdout),
      diff: String(diff.stdout || diff.stderr || ''),
      currentPatchMeta: String(meta.stdout || meta.stderr || ''),
      currentPatch: String(patch.stdout || patch.stderr || ''),
    };
  }

  /** @public */
  async function isCherryPickInProgress(tmpDir) {
    const target = normalizeIntegratePath(tmpDir, 'tempWorktreePath');
    const head = await runGitCommand(target, ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD']);
    return { inProgress: runGitOk(head) };
  }

  const computeCleanIntegrateWorktreesToSync = async ({ repoRoot, targetBranch, excludePaths }) => {
    const targetRef = `refs/heads/${targetBranch}`;
    const exclude = new Set(excludePaths);
    const entries = await listGitWorktreesForIntegrate(repoRoot);
    const candidates = entries
      .filter((entry) => entry.branchRef === targetRef)
      .map((entry) => entry.path)
      .filter((candidate) => candidate && !exclude.has(candidate));

    const clean = [];
    for (const candidate of candidates) {
      const status = await runGitCommand(candidate, ['status', '--porcelain']);
      if (!gitStdoutText(status)) {
        clean.push(candidate);
      }
    }
    return clean;
  };

  const syncCleanIntegrateTargetWorktrees = async (paths) => {
    for (const target of paths) {
      await runGitCommand(target, ['reset', '--hard']).catch(() => undefined);
    }
  };

  const normalizeIntegratePlan = async (plan = {}) => {
    const repoRoot = normalizeIntegratePath(plan.repoRoot, 'repoRoot');
    const sourceBranch = normalizeIntegrateBranch(plan.sourceBranch, 'sourceBranch');
    const targetBranch = normalizeIntegrateBranch(plan.targetBranch, 'targetBranch');
    const commits = Array.isArray(plan.commits) ? plan.commits.map(normalizeIntegrateSha) : [];
    return { repoRoot, sourceBranch, targetBranch, commits };
  };

  const normalizeIntegrateState = (state = {}) => ({
    repoRoot: normalizeIntegratePath(state.repoRoot, 'repoRoot'),
    tempWorktreePath: normalizeIntegratePath(state.tempWorktreePath, 'tempWorktreePath'),
    sourceBranch: normalizeIntegrateBranch(state.sourceBranch, 'sourceBranch'),
    targetBranch: normalizeIntegrateBranch(state.targetBranch, 'targetBranch'),
    cleanTargetWorktrees: Array.isArray(state.cleanTargetWorktrees)
      ? state.cleanTargetWorktrees.map((entry) => normalizeIntegratePath(entry, 'cleanTargetWorktree'))
      : [],
    remainingCommits: Array.isArray(state.remainingCommits) ? state.remainingCommits.map(normalizeIntegrateSha) : [],
    currentCommit: normalizeIntegrateSha(state.currentCommit),
  });

  /** @public */
  async function integrateWorktreeCommits(inputPlan = {}) {
    const plan = await normalizeIntegratePlan(inputPlan);
    if (plan.commits.length === 0) {
      return { kind: 'noop', reason: 'No commits to move' };
    }

    const tmpDir = await createIntegrateTempWorktree(plan.repoRoot, plan.targetBranch);
    let cleanTargetWorktrees = [];
    let remaining = [];
    try {
      await maybeFastForwardIntegrateUpstream(tmpDir);

      const clean = await runGitCommand(tmpDir, ['status', '--porcelain']);
      if (gitStdoutText(clean)) {
        throw new Error('Target branch has local changes; abort integration and retry');
      }

      cleanTargetWorktrees = await computeCleanIntegrateWorktreesToSync({
        repoRoot: plan.repoRoot,
        targetBranch: plan.targetBranch,
        excludePaths: [tmpDir],
      }).catch(() => []);

      remaining = [...plan.commits];
      while (remaining.length > 0) {
        const sha = remaining[0];
        const pick = await runGitCommand(tmpDir, ['cherry-pick', sha]);
        if (runGitOk(pick)) {
          remaining.shift();
          continue;
        }

        const unmerged = await runGitCommand(tmpDir, ['diff', '--name-only', '--diff-filter=U']);
        const unmergedFiles = trimGitLines(unmerged.stdout);
        if (unmergedFiles.length > 0) {
          const details = await getIntegrateConflictDetails(tmpDir);
          return {
            kind: 'conflict',
            state: {
              repoRoot: plan.repoRoot,
              tempWorktreePath: tmpDir,
              sourceBranch: plan.sourceBranch,
              targetBranch: plan.targetBranch,
              cleanTargetWorktrees,
              remainingCommits: remaining,
              currentCommit: sha,
            },
            details,
          };
        }

        throw new Error(gitStderrText(pick) || 'Cherry-pick failed');
      }

      await removeIntegrateTempWorktree(plan.repoRoot, tmpDir);
      await syncCleanIntegrateTargetWorktrees(cleanTargetWorktrees).catch(() => undefined);
      return { kind: 'success', moved: plan.commits.length };
    } catch (error) {
      await removeIntegrateTempWorktree(plan.repoRoot, tmpDir).catch(() => undefined);
      throw error;
    }
  }

  /** @public */
  async function abortIntegrate(stateInput = {}) {
    const state = normalizeIntegrateState(stateInput);
    await runGitCommand(state.tempWorktreePath, ['cherry-pick', '--abort']).catch(() => undefined);
    await removeIntegrateTempWorktree(state.repoRoot, state.tempWorktreePath);
    return { success: true };
  }

  /** @public */
  async function continueIntegrate(stateInput = {}) {
    const state = normalizeIntegrateState(stateInput);
    const cont = await runGitCommand(state.tempWorktreePath, ['cherry-pick', '--continue']);
    if (!runGitOk(cont)) {
      const unmerged = await runGitCommand(state.tempWorktreePath, ['diff', '--name-only', '--diff-filter=U']);
      if (trimGitLines(unmerged.stdout).length > 0) {
        const details = await getIntegrateConflictDetails(state.tempWorktreePath);
        return { kind: 'conflict', state, details };
      }
      throw new Error(gitStderrText(cont) || 'Cherry-pick continue failed');
    }

    const remaining = [...state.remainingCommits];
    if (remaining.length > 0 && remaining[0] === state.currentCommit) {
      remaining.shift();
    }

    const still = [...remaining];
    while (still.length > 0) {
      const sha = still[0];
      const pick = await runGitCommand(state.tempWorktreePath, ['cherry-pick', sha]);
      if (runGitOk(pick)) {
        still.shift();
        continue;
      }
      const unmerged = await runGitCommand(state.tempWorktreePath, ['diff', '--name-only', '--diff-filter=U']);
      if (trimGitLines(unmerged.stdout).length > 0) {
        const details = await getIntegrateConflictDetails(state.tempWorktreePath);
        return {
          kind: 'conflict',
          state: {
            ...state,
            remainingCommits: still,
            currentCommit: sha,
          },
          details,
        };
      }
      throw new Error(gitStderrText(pick) || 'Cherry-pick failed');
    }

    await removeIntegrateTempWorktree(state.repoRoot, state.tempWorktreePath);
    await syncCleanIntegrateTargetWorktrees(state.cleanTargetWorktrees).catch(() => undefined);
    return { kind: 'success', moved: state.remainingCommits.length };
  }

  return {
    computeIntegratePlan,
    getIntegrateConflictDetails,
    isCherryPickInProgress,
    integrateWorktreeCommits,
    abortIntegrate,
    continueIntegrate,
  };
}
