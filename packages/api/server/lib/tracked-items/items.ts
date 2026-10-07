// What the server can follow on a client's behalf: a GitHub pull request or
// issue, a GitLab merge request or issue, or a Linear issue. Parsed here once,
// at the boundary; everything past this file works with these shapes and the
// key they produce.

import { z } from 'zod';
import type { JsonValue } from '@opencode/client';

export type TrackedProvider = 'github' | 'gitlab' | 'linear';
export type TrackedKind = 'pull' | 'issue';

export interface TrackedGithubItem {
  provider: 'github';
  kind: TrackedKind;
  owner: string;
  repo: string;
  number: number;
  accountId?: string;
}

export interface TrackedGitlabItem {
  provider: 'gitlab';
  instance: string;
  kind: TrackedKind;
  owner: string;
  repo: string;
  number: number;
  accountId?: string;
}

export interface TrackedLinearItem {
  provider: 'linear';
  identifier: string;
}

export type TrackedItem = TrackedGithubItem | TrackedGitlabItem | TrackedLinearItem;

/**
 * A decoded candidate: the loose JSON object a client sends or a file holds,
 * before `parseTrackedItem` establishes the domain shape. Every field is
 * optional and unverified.
 */
export interface TrackedItemCandidate {
  provider?: JsonValue;
  kind?: JsonValue;
  owner?: JsonValue;
  repo?: JsonValue;
  number?: JsonValue;
  identifier?: JsonValue;
  instance?: JsonValue;
  accountId?: JsonValue;
}

/** What one provider answered about one item, in that provider's own shape. */
export type TrackedItemState = { [key: string]: JsonValue };

/** One item's state as broadcast to clients and written to disk. */
export interface TrackedItemPublicState {
  key: string;
  item: TrackedItem;
  state: TrackedItemState | null;
  fetchedAt: number;
}

/** The persisted subset: the key is recomputed from the item on load. */
export interface TrackedItemStateRecord {
  item: TrackedItem;
  state: TrackedItemState | null;
  fetchedAt: number;
}

/**
 * The JSON boundary every external payload crosses: a request body, a
 * persisted file or a provider answer is `unknown` until this decodes it.
 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

/** One provider's summary for one item, decoded from JSON. */
export const trackedItemStateSchema = z.record(z.string(), jsonValueSchema);

/**
 * A candidate as it arrives: any JSON value decodes to an object, and a
 * non-object decodes to the empty candidate `parseTrackedItem` drops.
 */
export const trackedItemCandidateSchema = trackedItemStateSchema.catch({});

/** The `items` list a request carries, before the per-item limit applies. */
export const trackedItemsSchema = z.array(trackedItemCandidateSchema);

const KINDS: ReadonlySet<string> = new Set(['pull', 'issue']);
const LINEAR_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const SEGMENT = /^[^\s/]+$/;
const NAMESPACE = /^[^\s/]+(?:\/[^\s/]+)*$/;

const isText = (value: JsonValue | undefined): value is string =>
  Object.prototype.toString.call(value) === '[object String]';

/** A JSON number probe, mirroring `isText`; `typeof` is banned by the anti-slop rule. */
export const isNumber = (value: JsonValue | undefined): value is number =>
  Object.prototype.toString.call(value) === '[object Number]';

const isCandidate = (value: TrackedItemCandidate | undefined): value is TrackedItemCandidate =>
  Object.prototype.toString.call(value) === '[object Object]';

const isTrackedKind = (value: string): value is TrackedKind => KINDS.has(value);

/** Reads a string field, trimming it; anything else is the empty string. */
export const readText = (value: JsonValue | undefined): string => (isText(value) ? value.trim() : '');

/** Reads a number field as its decimal spelling; anything else is the empty string. */
export const readNumberText = (value: JsonValue | undefined): string => (isNumber(value) ? String(value) : '');

/** Whether a value is a JSON object, for reading nested provider state. */
export const isPlainRecord = (value: JsonValue | undefined): value is TrackedItemState =>
  Object.prototype.toString.call(value) === '[object Object]';

const positiveNumber = (value: JsonValue | undefined): number | null =>
  isNumber(value) && Number.isSafeInteger(value) && value > 0 ? value : null;

const instanceOrigin = (value: JsonValue | undefined): string => {
  try {
    const url = new URL(readText(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin.toLowerCase() : '';
  } catch {
    return '';
  }
};

/**
 * One followed item, or null when the value names nothing the server can
 * read. GitLab owners are namespace paths and may contain subgroups; GitHub
 * owners and every repository name are single segments. `accountId` names the
 * account a repository is bound to (a branch's pull request); without it the
 * host's current account reads it (a linked item).
 */
export function parseTrackedItem(value?: TrackedItemCandidate): TrackedItem | null {
  if (!isCandidate(value)) return null;
  const provider = readText(value.provider);
  if (provider === 'linear') {
    const identifier = readText(value.identifier).toUpperCase();
    return LINEAR_IDENTIFIER.test(identifier) ? { provider: 'linear', identifier } : null;
  }
  const kind = readText(value.kind);
  const owner = readText(value.owner);
  const repo = readText(value.repo);
  const number = positiveNumber(value.number);
  if (!isTrackedKind(kind) || !SEGMENT.test(repo) || number === null) return null;
  const accountId = readText(value.accountId);
  if (provider === 'github') {
    if (!SEGMENT.test(owner)) return null;
    const item: TrackedGithubItem = { provider: 'github', kind, owner, repo, number };
    if (accountId) item.accountId = accountId;
    return item;
  }
  if (provider === 'gitlab') {
    const instance = instanceOrigin(value.instance);
    if (!instance || !NAMESPACE.test(owner)) return null;
    const item: TrackedGitlabItem = { provider: 'gitlab', instance, kind, owner, repo, number };
    if (accountId) item.accountId = accountId;
    return item;
  }
  return null;
}

/** Case-insensitive identity, the same one the UI computes for the same item. */
export function trackedItemKey(item: TrackedItem): string {
  if (item.provider === 'linear') return `linear|${item.identifier.toUpperCase()}`;
  const thread = `${item.kind}|${item.owner}/${item.repo}#${item.number}`.toLowerCase();
  // Account ids are opaque and case-sensitive; they stay as they are.
  const account = item.accountId ? `@${item.accountId}` : '';
  return item.provider === 'gitlab' ? `gitlab|${item.instance}|${thread}${account}` : `github|${thread}${account}`;
}

/** Reads a decoded list of candidates, dropping malformed ones and duplicates; null when the list exceeds the limit. */
export function parseTrackedItems(values: TrackedItemCandidate[], limit: number): Map<string, TrackedItem> | null {
  if (values.length > limit) return null;
  const items = new Map<string, TrackedItem>();
  for (const raw of values) {
    const item = parseTrackedItem(raw);
    if (item) items.set(trackedItemKey(item), item);
  }
  return items;
}
