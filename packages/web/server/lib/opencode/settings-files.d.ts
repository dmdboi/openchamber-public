/**
 * Shared types for the canonical settings-files module (`settings-files.js`).
 * The VS Code extension host re-exports this module through
 * `packages/vscode/src/settings-files.ts`, so these names are the contract for
 * both runtimes.
 */

export type SettingsSurface = 'web' | 'desktop' | 'vscode' | 'mobile';

/** One registry snapshot field; only the facts this module reads are named. */
export type SettingsRegistryField = {
  scope?: string;
  perSurface?: boolean;
  computed?: boolean;
  secret?: boolean;
  local?: boolean;
  owner?: string;
};

/** A value decoded from a preferences file or a merged settings document. */
export type PreferenceValue =
  | string
  | number
  | boolean
  | null
  | PreferenceValue[]
  | { [key: string]: PreferenceValue };

export type SurfaceValue = { value: PreferenceValue; updatedAt: number };

export type PreferenceField = {
  /** Absent for a per-surface key first set from a single surface kind. */
  value?: PreferenceValue;
  updatedAt: number;
  surfaces?: Partial<Record<SettingsSurface, SurfaceValue>>;
};

export type PreferenceFields = Record<string, PreferenceField>;

export type ParsedPreferencesDocument =
  | { ok: true; fields: PreferenceFields }
  | { ok: false; reason: string };

export function provideSettingsRegistryFields(fields: Record<string, SettingsRegistryField>): void;
export function normalizeSettingsSurface(value: string): SettingsSurface | null;
export function settingsSurfaceOf(request: {
  query?: { surface?: string };
  get?: (header: string) => string | undefined;
}): SettingsSurface | null;
export function isProfileSettingsKey(key: string): boolean;
export function isDeviceSettingsKey(key: string): boolean;
export function isPerSurfaceSettingsKey(key: string): boolean;
export function preferencesFilePathFor(settingsFilePath: string): string;
export function parsePreferencesDocument(raw: string): ParsedPreferencesDocument;
export function serializePreferencesDocument(fields: PreferenceFields): string;
export function flattenPreferences(
  fields: PreferenceFields,
  surface?: SettingsSurface | null,
): Record<string, PreferenceValue>;
export function buildPreferencesFields<T>(
  previousFields: PreferenceFields,
  document: Record<string, T>,
  now: number,
  options?: { surface?: SettingsSurface | null; changedKeys?: Iterable<string> | null },
): PreferenceFields;
export function instancePartOf<T>(document: Record<string, T>): Record<string, T>;
export function profilePartOf<T>(document: Record<string, T>): Record<string, T>;
export function legacySettingsDocumentOf<T>(
  document: Record<string, T>,
  preferenceFields: PreferenceFields,
): Record<string, T>;
export function seedPreferencesFrom<T>(document: Record<string, T>, now: number): PreferenceFields;
export function readMergedSettingsSync(deps: {
  fs: { readFileSync(path: string, encoding: string): string };
  path: typeof import('node:path');
  settingsFilePath: string;
}): Record<string, PreferenceValue>;
