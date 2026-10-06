/**
 * Type declarations for the quota provider registry, consumed by the VS Code
 * extension host (`packages/vscode/src/quotaProviders.ts`). Keep in step with
 * `index.js`: the extension host bundles this module with esbuild and needs the
 * shared implementation typed the same way the web server uses it.
 */

import type { JsonValue } from '@opencode/client';

export type QuotaAuthEntry = Record<string, JsonValue | undefined> | string;
export type QuotaAuthFile = Record<string, QuotaAuthEntry>;

export interface QuotaGiftReset {
  recordId: number;
  expireAt: number;
}

export interface QuotaUsageWindow {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string | null;
  giftReset?: QuotaGiftReset | null;
}

export interface QuotaUsage {
  windows: Record<string, QuotaUsageWindow>;
  models?: Record<string, QuotaUsage>;
}

export interface QuotaProviderResult {
  providerId: string;
  providerName: string;
  ok: boolean;
  configured: boolean;
  usage: QuotaUsage | null;
  fetchedAt: number;
  error?: string;
  planLabel?: string | null;
}

export type QuotaFetch = (url: string, options: RequestInit) => Promise<Response>;
export type QuotaReadAuth = () => QuotaAuthFile | Promise<QuotaAuthFile>;

/** Providers whose fetcher accepts injected auth and/or fetch. */
export interface QuotaFetchDependencies {
  readAuth?: QuotaReadAuth;
  fetchImpl?: QuotaFetch;
}

/** ZenMux reads its Platform API key from the managed credential store. */
export interface QuotaManagedCredential {
  platformApiKey?: string;
}

export interface QuotaCredentialDependencies {
  readCredential?: () => QuotaManagedCredential | null;
  fetchImpl?: QuotaFetch;
}

export function listConfiguredQuotaProviders(): Promise<string[]>;
export function fetchQuotaForProvider(providerId: string): Promise<QuotaProviderResult>;

export const fetchClaudeQuota: () => Promise<QuotaProviderResult>;
export const fetchCodexQuota: () => Promise<QuotaProviderResult>;
export const fetchGoogleQuota: () => Promise<QuotaProviderResult>;
export const fetchCursorQuota: () => Promise<QuotaProviderResult>;
export const fetchDeepinfraQuota: () => Promise<QuotaProviderResult>;
export const fetchDeepseekQuota: () => Promise<QuotaProviderResult>;
export const fetchCopilotQuota: () => Promise<QuotaProviderResult>;
export const fetchCopilotAddonQuota: () => Promise<QuotaProviderResult>;
export const fetchKimiQuota: (dependencies?: QuotaFetchDependencies) => Promise<QuotaProviderResult>;
export const fetchOpenRouterQuota: () => Promise<QuotaProviderResult>;
export const fetchZaiQuota: () => Promise<QuotaProviderResult>;
export const fetchZhipuaiQuota: () => Promise<QuotaProviderResult>;
export const fetchNanoGptQuota: (dependencies?: QuotaFetchDependencies) => Promise<QuotaProviderResult>;
export const fetchMinimaxCodingPlanQuota: () => Promise<QuotaProviderResult>;
export const fetchMinimaxCnCodingPlanQuota: () => Promise<QuotaProviderResult>;
export const fetchWaferQuota: () => Promise<QuotaProviderResult>;
export const fetchClinePassQuota: (dependencies?: QuotaFetchDependencies) => Promise<QuotaProviderResult>;
export const fetchHyperQuota: (dependencies?: QuotaFetchDependencies) => Promise<QuotaProviderResult>;
export const fetchXaiQuota: (dependencies?: QuotaFetchDependencies) => Promise<QuotaProviderResult>;
export const fetchZenmuxQuota: (dependencies?: QuotaCredentialDependencies) => Promise<QuotaProviderResult>;
export const fetchNeuralwattQuota: () => Promise<QuotaProviderResult>;
export const fetchExeDevQuota: () => Promise<QuotaProviderResult>;
export const fetchOpenCodeGoQuota: () => Promise<QuotaProviderResult>;
