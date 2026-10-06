import type { SessionWorktreeAttachment } from '@/stores/types/sessionTypes';
import { normalizePath as normalizePathImpl } from '@/lib/pathNormalization';

const normalizePath = (value: string | null | undefined): string => normalizePathImpl(value) ?? '';

export function getAttachedSessionDirectory(
  attachment: SessionWorktreeAttachment | null | undefined,
  fallbackDirectory?: string | null,
): string | null {
  if (attachment) {
    if (!attachment.degraded && attachment.cwd) {
      return normalizePath(attachment.cwd);
    }
    if (attachment.worktreeRoot) {
      return normalizePath(attachment.worktreeRoot);
    }
    if (attachment.cwd) {
      return normalizePath(attachment.cwd);
    }
  }

  if (fallbackDirectory) {
    return normalizePath(fallbackDirectory);
  }

  return null;
}



export function formatSessionWorktreeBadge(
  attachment: SessionWorktreeAttachment,
  labels?: { pending?: string; missing?: string }
): string {
  if (attachment.legacy) return 'Legacy session';
  if (attachment.worktreeStatus === 'pending') return labels?.pending ?? 'Needs attention';
  if (attachment.worktreeStatus === 'missing') return labels?.missing ?? 'Worktree missing';
  if (attachment.worktreeStatus === 'not-a-repo') return 'Not a repo';
  if (attachment.worktreeStatus === 'invalid') return 'Needs attention';
  if (attachment.attentionReason) return 'Needs attention';
  if (attachment.headState === 'detached') return 'Detached HEAD';
  if (attachment.headState === 'unborn') return 'Unborn branch';
  if (attachment.branch) return `Current branch: ${attachment.branch}`;
  return 'No branch';
}

export type SessionWorktreeRepairAction = 'locate' | 'open-without-worktree-features';

export function getSessionWorktreeRepairActions(
  attachment: SessionWorktreeAttachment
): SessionWorktreeRepairAction[] {
  if (attachment.worktreeStatus === 'missing' || attachment.worktreeStatus === 'invalid') {
    return ['open-without-worktree-features'];
  }
  return [];
}

export type MutationBlockingReason =
  | { reason: 'attention'; attentionReason: NonNullable<SessionWorktreeAttachment['attentionReason']> }
  | { reason: 'missing' }
  | { reason: 'invalid' }
  | { reason: 'dirty'; dirtyFiles?: number };

export function getMutationBlockingReasons(
  attachment: SessionWorktreeAttachment | null | undefined,
  gitStatus?: { isClean?: boolean; files?: Array<{ path: string }> }
): MutationBlockingReason[] {
  const reasons: MutationBlockingReason[] = [];
  if (gitStatus && gitStatus.isClean === false) {
    const dirtyFiles = gitStatus.files?.length;
    reasons.push(dirtyFiles != null ? { reason: 'dirty', dirtyFiles } : { reason: 'dirty' });
  }
  if (!attachment) return reasons;
  if (attachment.worktreeStatus === 'missing') {
    reasons.push({ reason: 'missing' });
  }
  if (attachment.worktreeStatus === 'invalid') {
    reasons.push({ reason: 'invalid' });
  }
  if (attachment.attentionReason) {
    reasons.push({ reason: 'attention', attentionReason: attachment.attentionReason });
  }
  return reasons;
}

export type SessionTargetOption = {
  value: string;
  label: string;
  kind: 'root' | 'worktree';
  pending?: boolean;
};

export function buildSessionTargetOptions(input: {
  projectRoot: string;
  rootBranch: string;
  worktrees: Array<{ path: string; branch: string; label: string; projectDirectory: string }>;
  pendingBootstrapDirectory?: string | null;
}): SessionTargetOption[] {
  const options: SessionTargetOption[] = [];

  if (input.projectRoot) {
    options.push({
      value: input.projectRoot,
      label: input.rootBranch || input.projectRoot.split('/').pop() || input.projectRoot,
      kind: 'root',
    });
  }

  const pendingNormalized = input.pendingBootstrapDirectory
    ? normalizePath(input.pendingBootstrapDirectory)
    : null;

  for (const wt of input.worktrees) {
    const normalizedPath = normalizePath(wt.path);
    if (normalizedPath === input.projectRoot) continue;
    const isPending = normalizedPath === pendingNormalized;
    options.push({
      value: normalizedPath,
      label: wt.branch?.trim() || wt.label || normalizedPath.split('/').pop() || normalizedPath,
      kind: 'worktree',
      pending: isPending || undefined,
    });
  }

  return options;
}
