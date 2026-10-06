import { describe, expect, test } from 'bun:test';
import {
  getAttachedSessionDirectory,
  formatSessionWorktreeBadge,
  getSessionWorktreeRepairActions,
  getMutationBlockingReasons,
  buildSessionTargetOptions,
} from '../../../src/sync/session-worktree-contract';

describe('getAttachedSessionDirectory', () => {
  test('prefers canonical cwd when attachment is healthy', () => {
    expect(getAttachedSessionDirectory({
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a/src',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: false,
    }, '/repo')).toBe('/repo/worktrees/feat-a/src');
  });

  test('falls back to worktree root when attachment is degraded', () => {
    expect(getAttachedSessionDirectory({
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/tmp/outside',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'invalid',
      worktreeSource: 'existing',
      legacy: false,
      degraded: true,
    }, '/repo')).toBe('/repo/worktrees/feat-a');
  });

  test('uses fallback when no attachment exists', () => {
    expect(getAttachedSessionDirectory(null, '/repo')).toBe('/repo');
  });
});



describe('formatSessionWorktreeBadge', () => {
  test('formats needs-attention badge for invalid worktree', () => {
    const badge = formatSessionWorktreeBadge({
      worktreeStatus: 'invalid',
      degraded: true,
      legacy: false,
      branch: null,
      headState: 'detached',
      worktreeRoot: null,
      cwd: null,
      worktreeSource: null,
    });
    expect(badge).toBe('Needs attention');
  });

  test('formats legacy session badge', () => {
    const badge = formatSessionWorktreeBadge({
      legacy: true,
      worktreeStatus: 'invalid',
      degraded: true,
      branch: null,
      headState: 'branch',
      worktreeRoot: null,
      cwd: null,
      worktreeSource: null,
    });
    expect(badge).toBe('Legacy session');
  });

  test('formats detached HEAD', () => {
    const badge = formatSessionWorktreeBadge({
      headState: 'detached',
      degraded: false,
      legacy: false,
      branch: null,
      worktreeStatus: 'ready',
      worktreeRoot: '/repo',
      cwd: '/repo',
      worktreeSource: 'existing',
    });
    expect(badge).toBe('Detached HEAD');
  });

  test('formats unborn branch', () => {
    const badge = formatSessionWorktreeBadge({
      headState: 'unborn',
      degraded: false,
      legacy: false,
      branch: null,
      worktreeStatus: 'ready',
      worktreeRoot: '/repo',
      cwd: '/repo',
      worktreeSource: 'existing',
    });
    expect(badge).toBe('Unborn branch');
  });

  test('formats current branch name', () => {
    const badge = formatSessionWorktreeBadge({
      branch: 'feature/my-branch',
      headState: 'branch',
      degraded: false,
      legacy: false,
      worktreeStatus: 'ready',
      worktreeRoot: '/repo',
      cwd: '/repo',
      worktreeSource: 'existing',
    });
    expect(badge).toBe('Current branch: feature/my-branch');
  });

  test('formats missing worktree', () => {
    const badge = formatSessionWorktreeBadge({
      worktreeStatus: 'missing',
      degraded: true,
      legacy: false,
      branch: null,
      headState: 'branch',
      worktreeRoot: null,
      cwd: null,
      worktreeSource: null,
    });
    expect(badge).toBe('Worktree missing');
  });

  test('formats needs-attention for in-progress git operation', () => {
    const badge = formatSessionWorktreeBadge({
      worktreeStatus: 'ready',
      attentionReason: 'merge',
      degraded: false,
      legacy: false,
      branch: 'main',
      headState: 'branch',
      worktreeRoot: '/repo',
      cwd: '/repo',
      worktreeSource: 'existing',
    });
    expect(badge).toBe('Needs attention');
  });
});

describe('getSessionWorktreeRepairActions', () => {
  test('returns open-without-worktree-features for missing worktree', () => {
    const actions = getSessionWorktreeRepairActions({
      worktreeStatus: 'missing',
      degraded: true,
      legacy: false,
      branch: null,
      headState: 'branch',
      worktreeRoot: null,
      cwd: null,
      worktreeSource: null,
    });
    expect(actions).toContain('open-without-worktree-features');
  });

  test('returns open-without-worktree-features for invalid worktree', () => {
    const actions = getSessionWorktreeRepairActions({
      worktreeStatus: 'invalid',
      degraded: true,
      legacy: false,
      branch: null,
      headState: 'branch',
      worktreeRoot: null,
      cwd: null,
      worktreeSource: null,
    });
    expect(actions).toContain('open-without-worktree-features');
  });

  test('returns empty for ready worktree', () => {
    const actions = getSessionWorktreeRepairActions({
      worktreeStatus: 'ready',
      degraded: false,
      legacy: false,
      branch: 'main',
      headState: 'branch',
      worktreeRoot: '/repo',
      cwd: '/repo',
      worktreeSource: 'existing',
    });
    expect(actions).toHaveLength(0);
  });
});

describe('buildSessionTargetOptions', () => {
  test('labels root directory and isolated worktrees distinctly', () => {
    const options = buildSessionTargetOptions({
      projectRoot: '/repo',
      rootBranch: 'main',
      worktrees: [
        { path: '/repo/.worktrees/feat-a', branch: 'feat-a', label: 'feat-a', projectDirectory: '/repo' },
      ],
    });

    expect(options[0]?.label).toContain('main');
    expect(options[1]?.label).toContain('feat-a');
    expect(options[0]?.kind).toBe('root');
    expect(options[1]?.kind).toBe('worktree');
  });

  test('excludes worktree path that equals projectRoot', () => {
    const options = buildSessionTargetOptions({
      projectRoot: '/repo',
      rootBranch: 'main',
      worktrees: [
        { path: '/repo', branch: 'main', label: 'main', projectDirectory: '/repo' },
        { path: '/repo/worktrees/feat-a', branch: 'feat-a', label: 'feat-a', projectDirectory: '/repo' },
      ],
    });

    expect(options).toHaveLength(2); // root + one worktree, not three
  });

  test('handles empty worktrees array', () => {
    const options = buildSessionTargetOptions({
      projectRoot: '/repo',
      rootBranch: 'main',
      worktrees: [],
    });

    expect(options).toHaveLength(1);
    expect(options[0]?.kind).toBe('root');
  });

  test('marks pending bootstrap worktree distinctly', () => {
    const options = buildSessionTargetOptions({
      projectRoot: '/repo',
      rootBranch: 'main',
      worktrees: [
        { path: '/repo/worktrees/feat-a', branch: 'feat-a', label: 'feat-a', projectDirectory: '/repo' },
        { path: '/repo/worktrees/feat-b', branch: 'feat-b', label: 'feat-b', projectDirectory: '/repo' },
      ],
      pendingBootstrapDirectory: '/repo/worktrees/feat-b',
    });

    const root = options.find((o) => o.kind === 'root');
    const pending = options.find((o) => o.value === '/repo/worktrees/feat-b');
    const nonPending = options.find((o) => o.value === '/repo/worktrees/feat-a');

    expect(root?.pending).toBeUndefined();
    expect(pending?.pending).toBe(true);
    expect(nonPending?.pending).toBeUndefined();
  });
});

describe('getMutationBlockingReasons', () => {
  test('returns empty when attachment is null', () => {
    expect(getMutationBlockingReasons(null)).toHaveLength(0);
    expect(getMutationBlockingReasons(undefined)).toHaveLength(0);
  });

  test('blocks mutation when worktree is missing', () => {
    const reasons = getMutationBlockingReasons({
      worktreeRoot: null,
      cwd: null,
      branch: null,
      headState: 'branch',
      worktreeStatus: 'missing',
      worktreeSource: null,
      legacy: false,
      degraded: true,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toEqual({ reason: 'missing' });
  });

  test('blocks mutation when worktree is invalid', () => {
    const reasons = getMutationBlockingReasons({
      worktreeRoot: null,
      cwd: null,
      branch: null,
      headState: 'branch',
      worktreeStatus: 'invalid',
      worktreeSource: null,
      legacy: false,
      degraded: true,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toEqual({ reason: 'invalid' });
  });

  test('blocks mutation during merge attention state', () => {
    const reasons = getMutationBlockingReasons({
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: false,
      attentionReason: 'merge',
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toEqual({ reason: 'attention', attentionReason: 'merge' });
  });

  test('blocks mutation during rebase attention state', () => {
    const reasons = getMutationBlockingReasons({
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: false,
      attentionReason: 'rebase',
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toEqual({ reason: 'attention', attentionReason: 'rebase' });
  });

  test('returns empty for ready worktree with no attention', () => {
    const reasons = getMutationBlockingReasons({
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: false,
    });
    expect(reasons).toHaveLength(0);
  });

  test('blocks mutation during cherry-pick attention state', () => {
    const reasons = getMutationBlockingReasons({
      worktreeRoot: '/repo/worktrees/feat-a',
      cwd: '/repo/worktrees/feat-a',
      branch: 'feat-a',
      headState: 'branch',
      worktreeStatus: 'ready',
      worktreeSource: 'existing',
      legacy: false,
      degraded: false,
      attentionReason: 'cherry-pick',
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toEqual({ reason: 'attention', attentionReason: 'cherry-pick' });
  });

  test('blocks mutation when git status is dirty', () => {
    const reasons = getMutationBlockingReasons(
      { worktreeRoot: '/repo', cwd: '/repo', branch: 'main', headState: 'branch', worktreeStatus: 'ready', worktreeSource: 'existing', legacy: false, degraded: false },
      { isClean: false, files: [{ path: 'a.ts' }, { path: 'b.ts' }] }
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toEqual({ reason: 'dirty', dirtyFiles: 2 });
  });

  test('blocks mutation for dirty tree even without attachment', () => {
    const reasons = getMutationBlockingReasons(null, { isClean: false, files: [{ path: 'a.ts' }] });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toEqual({ reason: 'dirty', dirtyFiles: 1 });
  });

  test('does not block when git status is clean', () => {
    const reasons = getMutationBlockingReasons(
      { worktreeRoot: '/repo', cwd: '/repo', branch: 'main', headState: 'branch', worktreeStatus: 'ready', worktreeSource: 'existing', legacy: false, degraded: false },
      { isClean: true, files: [] }
    );
    expect(reasons).toHaveLength(0);
  });

  test('returns dirty and missing reasons together', () => {
    const reasons = getMutationBlockingReasons(
      { worktreeRoot: '/repo', cwd: '/repo', branch: 'main', headState: 'branch', worktreeStatus: 'missing', worktreeSource: 'existing', legacy: false, degraded: false },
      { isClean: false, files: [{ path: 'a.ts' }] }
    );
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toEqual({ reason: 'dirty', dirtyFiles: 1 });
    expect(reasons[1]).toEqual({ reason: 'missing' });
  });

  test('returns dirty without file count when files is undefined', () => {
    const reasons = getMutationBlockingReasons(
      null,
      { isClean: false }
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toEqual({ reason: 'dirty' });
  });
});
