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
export type TrackedItemState = {
    [key: string]: JsonValue;
};
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
export declare const jsonValueSchema: z.ZodType<JsonValue>;
/** One provider's summary for one item, decoded from JSON. */
export declare const trackedItemStateSchema: z.ZodRecord<z.ZodString, z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
/**
 * A candidate as it arrives: any JSON value decodes to an object, and a
 * non-object decodes to the empty candidate `parseTrackedItem` drops.
 */
export declare const trackedItemCandidateSchema: z.ZodCatch<z.ZodRecord<z.ZodString, z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>>;
/** The `items` list a request carries, before the per-item limit applies. */
export declare const trackedItemsSchema: z.ZodArray<z.ZodCatch<z.ZodRecord<z.ZodString, z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>>>;
/** A JSON number probe, mirroring `isText`; `typeof` is banned by the anti-slop rule. */
export declare const isNumber: (value: JsonValue | undefined) => value is number;
/** Reads a string field, trimming it; anything else is the empty string. */
export declare const readText: (value: JsonValue | undefined) => string;
/** Reads a number field as its decimal spelling; anything else is the empty string. */
export declare const readNumberText: (value: JsonValue | undefined) => string;
/** Whether a value is a JSON object, for reading nested provider state. */
export declare const isPlainRecord: (value: JsonValue | undefined) => value is TrackedItemState;
/**
 * One followed item, or null when the value names nothing the server can
 * read. GitLab owners are namespace paths and may contain subgroups; GitHub
 * owners and every repository name are single segments. `accountId` names the
 * account a repository is bound to (a branch's pull request); without it the
 * host's current account reads it (a linked item).
 */
export declare function parseTrackedItem(value?: TrackedItemCandidate): TrackedItem | null;
/** Case-insensitive identity, the same one the UI computes for the same item. */
export declare function trackedItemKey(item: TrackedItem): string;
/** Reads a decoded list of candidates, dropping malformed ones and duplicates; null when the list exceeds the limit. */
export declare function parseTrackedItems(values: TrackedItemCandidate[], limit: number): Map<string, TrackedItem> | null;
