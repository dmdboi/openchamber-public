/**
 * Shared types for the canonical project-setup module (`project-setup.js`).
 * The VS Code extension host re-exports this module through
 * `packages/vscode/src/project-setup.ts`, so these names are the contract for
 * both runtimes.
 *
 * The `unknown` inputs below are the parse boundary: these functions read a
 * raw personal config document or a client patch and return the sanitized
 * domain shape, so callers hand over unparsed JSON on purpose.
 */

export type ActionPlatform = 'macos' | 'linux' | 'windows';

export type ProjectAction = {
  id: string;
  name: string;
  command: string;
  icon: string | null;
  autoOpenUrl?: true;
  openUrl?: string;
  desktopOpenSshForward?: string;
  platforms?: ActionPlatform[];
  runIn?: 'parent';
};

export type DraftStarter = { type: 'command' | 'skill'; name: string };

export type SetupWorktreeMode = 'append' | 'replace';

export type PersonalProjectSetup = {
  setupWorktree: string[];
  setupWorktreeWait: boolean | null;
  setupWorktreeMode: SetupWorktreeMode;
  projectActions: ProjectAction[];
  projectActionsPrimaryId: string | null;
  draftStarters: DraftStarter[];
  hiddenSharedActionIds: string[];
  sharedTrust: { hash: string; trustedAt: number } | null;
};

export type SharedProjectConfig = {
  setupWorktree: string[];
  setupWorktreeWait: boolean | null;
  projectActions: ProjectAction[];
  draftStarters: DraftStarter[];
  plansDir: string | null;
};

export type SharedProjectConfigRead =
  | { status: 'missing' }
  | { status: 'ok'; config: SharedProjectConfig }
  | { status: 'invalid'; reason: string };

export type ProjectSetupSource = 'shared' | 'personal';

export type ProjectSetupView = {
  trust: { hash: string | null; trusted: boolean };
  setupWorktree: string[];
  setupWorktreeWait: boolean;
  projectActions: Array<ProjectAction & { source: ProjectSetupSource }>;
  projectActionsPrimaryId: string | null;
  draftStarters: Array<DraftStarter & { source: ProjectSetupSource }>;
  shared: SharedProjectConfig & {
    status: SharedProjectConfigRead['status'];
    reason?: string;
    path: string;
  };
  personal: PersonalProjectSetup;
};

/** The on-disk keys `projectSetupPatchToStored` owns; `undefined` removes a key. */
export type StoredProjectSetupPatch = {
  'setup-worktree'?: string[];
  'setup-worktree-wait'?: boolean;
  setupWorktreeMode?: SetupWorktreeMode;
  projectActions?: ProjectAction[];
  projectActionsPrimaryId?: string | undefined;
  draftStarters?: DraftStarter[];
  hiddenSharedActionIds?: string[];
  sharedTrust?: { hash: string; trustedAt: number } | undefined;
  projectPath?: string;
};

export const SHARED_CONFIG_RELATIVE_PATH: string;
export const DEFAULT_PLANS_DIR: string;
export const EMPTY_SHARED_PROJECT_CONFIG: SharedProjectConfig;

export class ProjectSetupValidationError extends Error {}

export function sanitizeSetupCommands(value: unknown): string[];
export function sanitizeProjectActions(value: unknown): ProjectAction[];
export function sanitizeDraftStarters(value: unknown): DraftStarter[];
export function projectSetupViewOf(raw: unknown): PersonalProjectSetup;
export function projectSetupPatchToStored(patch: unknown): StoredProjectSetupPatch;
export function normalizePlansDir(value: unknown): string | null;
export function parseSharedProjectConfig(raw: string): SharedProjectConfigRead;
export function sharedTrustHashOf(shared: SharedProjectConfig): string | null;
export function mergeProjectSetup(
  personal: PersonalProjectSetup,
  sharedRead: SharedProjectConfigRead,
): ProjectSetupView;
export function isSharedProjectConfigEmpty(config: SharedProjectConfig): boolean;
export function serializeSharedProjectConfig(config: SharedProjectConfig): string;
export function applySharedProjectSetupPatch(current: SharedProjectConfig, patch: unknown): SharedProjectConfig;
export function isProjectSetupValidationError(error: Error): boolean;
