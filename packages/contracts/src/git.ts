/**
 * Git API wire shapes shared by the shared UI and the VS Code extension host.
 *
 * These are the fields every runtime answers. A runtime with more to report
 * extends the base on its own type, so an absent optional field means "this
 * runtime did not report it", not "the value is zero". Runtime-only fields
 * stay next to the adapter that produces them.
 */

/** One file entry from a Git status read. */
export interface GitStatusFile {
  path: string;
  index: string;
  working_dir: string;
}

/** A merge in progress with conflicts. */
export interface GitMergeInProgress {
  /** Short SHA of MERGE_HEAD */
  head: string;
  /** First line of MERGE_MSG */
  message: string;
}

/** A rebase in progress. */
export interface GitRebaseInProgress {
  /** Branch name being rebased */
  headName: string;
  /** Short SHA of the onto commit */
  onto: string;
}

/** The checked-out branch compared with one remote branch. */
export interface GitRemoteComparison {
  remote: string;
  branch: string;
  ahead: number;
  behind: number;
}

/** Git status fields every runtime reports. Runtimes add optional fields of their own. */
export interface GitStatusBase {
  current: string;
  tracking: string | null;
  ahead: number;
  behind: number;
  /**
   * Per-file line stats split by Git scope. A file with edits in both scopes
   * appears in both maps; the values are never summed into each other.
   */
  diffStats?: {
    /** HEAD -> index (`git diff --cached --numstat`). */
    staged: Record<string, { insertions: number; deletions: number }>;
    /** index -> working tree (`git diff --numstat`). */
    working: Record<string, { insertions: number; deletions: number }>;
  };
  files: GitStatusFile[];
  isClean: boolean;
  /** Present when a merge is in progress with conflicts */
  mergeInProgress?: GitMergeInProgress | null;
  /** Present when a rebase is in progress */
  rebaseInProgress?: GitRebaseInProgress | null;
}

/**
 * What a submodule entry records. Its patch alone cannot say everything: a
 * submodule that only gained untracked files is modified in status while its
 * patch is empty. Commits are null where nothing is recorded, and
 * `worktreeCommit` is null when the submodule is not checked out.
 */
export interface GitSubmoduleState {
  headCommit: string | null;
  indexCommit: string | null;
  worktreeCommit: string | null;
  hasTrackedChanges: boolean;
  hasUntrackedFiles: boolean;
  /** Unmerged: the index holds conflicting commits and no single recorded one. */
  hasConflict: boolean;
}

export interface GitBranchDetails {
  current: boolean;
  name: string;
  commit: string;
  label: string;
  tracking?: string;
  ahead?: number;
  behind?: number;
}

/** Branch listing fields every runtime reports. Runtimes add optional fields of their own. */
export interface GitBranchBase {
  all: string[];
  current: string;
  branches: Record<string, GitBranchDetails>;
}

export interface GitWorktreeValidationError {
  code: string;
  message: string;
}

export interface GitWorktreeValidationResult {
  ok: boolean;
  errors: GitWorktreeValidationError[];
  resolved?: {
    mode?: 'new' | 'existing';
    localBranch?: string | null;
  };
}

/** Identity fields every runtime reports for one worktree. Runtimes add state of their own. */
export interface GitWorktreeIdentity {
  head: string;
  name: string;
  branch: string;
  path: string;
}
