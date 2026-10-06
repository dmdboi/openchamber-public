/**
 * VS Code quota providers.
 *
 * Provider calculations and HTTP fetches are the web server's canonical quota
 * modules, bundled into the extension host with esbuild (the same pattern as
 * `opencode-config-v2.ts`). The registry entrypoint is
 * `packages/web/server/lib/quota/providers/index.js`.
 *
 * Only providers whose web module would change credentials, storage, fetch
 * injection or quota response semantics stay in this file:
 *
 * - `kilo` and `ollama-cloud`: the web `fetchQuota` takes a different injected
 *   dependency shape than the extension's bridge and tests (kilo resolves the
 *   OpenCode config object, ollama-cloud accepts no injection), so re-exporting
 *   would change fetch injection and, for ollama-cloud, its HTTP error wording.
 * - `claude`, `cursor`, `zhipuai` and `minimax`: the web module reads additional
 *   credential sources (Claude Code Keychain/file/env, Cursor env/token files,
 *   opencode.json `options.apiKey`) or calls a different endpoint set than the
 *   extension does today, so a re-export would change credentials/storage or
 *   quota semantics.
 * - the configured-provider list, so detection matches the fetchers above.
 * - gift-reset activation, which the bridge exposes as its own message.
 * - the dispatcher, so the local providers keep their existing behavior.
 *
 * The remaining providers are re-exported from the registry so both runtimes
 * share one implementation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OPENCODE_CONFIG_DIR } from './opencodeConfigPaths';
import { readOpenCodeCredentials } from './opencodeAuth';
import { readCredential } from './quotaCredentials';
import { fetchOllamaUsage } from './ollamaQuota';
import {
  fetchCodexQuota,
  fetchCopilotQuota,
  fetchCopilotAddonQuota,
  fetchGoogleQuota,
  fetchKimiQuota,
  fetchNanoGptQuota,
  fetchOpenRouterQuota,
  fetchZaiQuota,
  fetchWaferQuota,
  fetchClinePassQuota,
  fetchHyperQuota,
  fetchXaiQuota,
  fetchZenmuxQuota,
  fetchNeuralwattQuota,
  fetchExeDevQuota,
  fetchOpenCodeGoQuota,
  fetchDeepinfraQuota,
  fetchDeepseekQuota,
} from '../../web/server/lib/quota/providers/index.js';
import type {
  QuotaProviderResult,
  QuotaUsage,
  QuotaUsageWindow,
} from '../../web/server/lib/quota/providers/index.js';

export {
  fetchClinePassQuota,
  fetchHyperQuota,
  fetchKimiQuota,
  fetchXaiQuota,
  fetchZenmuxQuota,
};

type AuthEntry = Record<string, unknown> | string;
type AuthFile = Record<string, AuthEntry>;

type UsageWindow = QuotaUsageWindow;
type ProviderUsage = QuotaUsage;
type ProviderResult = QuotaProviderResult;

type GoogleAuthSource = {
  sourceId: 'gemini' | 'antigravity';
  sourceLabel: string;
  accessToken?: string;
  refreshToken?: string;
  expires?: number;
  projectId?: string;
  email?: string;
};

type XaiAuthEntry = Record<string, unknown> & {
  type: 'oauth';
  access?: string;
  refresh?: string;
  expires?: unknown;
};

type ZhipuaiLimit = {
  type?: string;
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
};

type ZhipuaiPayload = {
  code?: number | null;
  msg?: string | null;
  success?: boolean;
  data?: {
    limits?: ZhipuaiLimit[];
    level?: string;
  };
};

const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');

const ANTIGRAVITY_ACCOUNTS_PATHS = [
  path.join(OPENCODE_CONFIG_DIR, 'antigravity-accounts.json'),
  path.join(OPENCODE_DATA_DIR, 'antigravity-accounts.json'),
];

const ZAI_TOKEN_WINDOW_SECONDS: Record<number, number> = {
  3: 60 * 60,
  6: 7 * 24 * 60 * 60,
};

const readJsonFile = (filePath: string): Record<string, unknown> | null => {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch (error) {
    console.warn(`Failed to read JSON file: ${filePath}`, error);
    return null;
  }
};

const getAuthEntry = (auth: AuthFile, aliases: string[]) => {
  for (const alias of aliases) {
    if (auth[alias]) {
      return auth[alias];
    }
  }
  return null;
};

const normalizeAuthEntry = (entry: AuthEntry | null) => {
  if (!entry) return null;
  if (typeof entry === 'string') {
    return { token: entry } as Record<string, unknown>;
  }
  if (typeof entry === 'object') {
    return entry;
  }
  return null;
};

const asObject = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' ? value as Record<string, unknown> : null
);

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const parseGoogleRefreshToken = (rawRefreshToken: unknown) => {
  const refreshToken = asNonEmptyString(rawRefreshToken);
  if (!refreshToken) {
    return { refreshToken: null, projectId: null, managedProjectId: null };
  }

  const [rawToken = '', rawProject = '', rawManagedProject = ''] = refreshToken.split('|');
  return {
    refreshToken: asNonEmptyString(rawToken),
    projectId: asNonEmptyString(rawProject),
    managedProjectId: asNonEmptyString(rawManagedProject),
  };
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const toTimestamp = (value: unknown): number | null => {
  if (!value) return null;
  if (typeof value === 'number') {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const formatResetTime = (timestamp: number) => {
  try {
    const resetDate = new Date(timestamp);
    const now = new Date();
    const isToday = resetDate.toDateString() === now.toDateString();

    if (isToday) {
      // Same day: show time only (e.g., "9:56 PM")
      return resetDate.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      });
    }

    // Different day: show date + weekday + time (e.g., "Feb 2, Sun 9:56 PM")
    return resetDate.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
};

const calculateResetAfterSeconds = (resetAt: number | null) => {
  if (!resetAt) return null;
  const delta = Math.floor((resetAt - Date.now()) / 1000);
  return delta < 0 ? 0 : delta;
};

const toUsageWindow = (data: { usedPercent: number | null; windowSeconds: number | null; resetAt: number | null; valueLabel?: string | null }): UsageWindow => {
  const resetAfterSeconds = calculateResetAfterSeconds(data.resetAt);
  const resetFormatted = data.resetAt ? formatResetTime(data.resetAt) : null;
  const window: UsageWindow = {
    usedPercent: data.usedPercent,
    remainingPercent: data.usedPercent !== null ? Math.max(0, 100 - data.usedPercent) : null,
    windowSeconds: data.windowSeconds ?? null,
    resetAfterSeconds,
    resetAt: data.resetAt,
    resetAtFormatted: resetFormatted,
    resetAfterFormatted: resetFormatted,
  };
  if (data.valueLabel) window.valueLabel = data.valueLabel;
  return window;
};

const buildResult = (data: {
  providerId: string;
  providerName: string;
  ok: boolean;
  configured: boolean;
  usage?: ProviderUsage | null;
  error?: string;
  planLabel?: string | null;
}): ProviderResult => {
  const result: ProviderResult = {
    providerId: data.providerId,
    providerName: data.providerName,
    ok: data.ok,
    configured: data.configured,
    usage: data.usage ?? null,
    fetchedAt: Date.now(),
  };
  if (data.error) result.error = data.error;
  if (data.planLabel) result.planLabel = data.planLabel;
  return result;
};

const formatMoney = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return null;
  return value.toFixed(2);
};

const normalizeTimestamp = (value: unknown) => {
  if (typeof value !== 'number') return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
};

const resolveWindowSeconds = (limit: Record<string, unknown> | undefined) => {
  if (!limit || typeof limit.number !== 'number') return null;
  const unitSeconds = ZAI_TOKEN_WINDOW_SECONDS[Number(limit.unit)];
  if (!unitSeconds) return null;
  return unitSeconds * limit.number;
};

const resolveWindowLabel = (windowSeconds: number | null) => {
  if (!windowSeconds) return 'tokens';
  if (windowSeconds % 86400 === 0) {
    const days = windowSeconds / 86400;
    return days === 7 ? 'weekly' : `${days}d`;
  }
  if (windowSeconds % 3600 === 0) {
    return `${windowSeconds / 3600}h`;
  }
  return `${windowSeconds}s`;
};

// Mirrors the Z.ai credit label (same monitor API family): `usage` is the
// total, `currentValue` the consumed amount.
const formatZhipuaiCreditAmount = (value: number): string => {
  if (value < 1000) return value.toLocaleString('en-US');
  return `${Math.round(value / 100) / 10}k`;
};

const formatZhipuaiCreditValueLabel = (limit: ZhipuaiLimit): string | null => {
  const used = toNumber(limit.currentValue);
  const total = toNumber(limit.usage);
  if (used === null || total === null) return null;
  return `${formatZhipuaiCreditAmount(used)} / ${formatZhipuaiCreditAmount(total)} credits`;
};

// `percentage` is the used percent; when the API omits it, derive it from
// currentValue/usage (observed percentages are integers).
const resolveZhipuaiUsedPercent = (limit: ZhipuaiLimit): number | null => {
  const percentage = toNumber(limit.percentage);
  if (percentage !== null) {
    return percentage;
  }
  const used = toNumber(limit.currentValue);
  const total = toNumber(limit.usage);
  if (used === null || total === null || total <= 0) return null;
  return Math.round((used / total) * 100);
};

// bigmodel.cn reports business failures inside HTTP 200 bodies
// (`{code, msg, success: false}`); a missing envelope is treated as legacy success.
const zhipuaiEnvelopeError = (payload: ZhipuaiPayload): string | null => {
  const code = payload?.code;
  if (payload?.success !== false && !(code !== undefined && code !== null && code !== 200)) {
    return null;
  }
  return asNonEmptyString(payload?.msg) ?? `API error: ${code ?? 'unknown'}`;
};

const resolveXaiAuth = (auth: AuthFile): XaiAuthEntry | null => {
  const entry = auth.xai;
  if (!entry || typeof entry !== 'object' || entry.type !== 'oauth') return null;

  const access = asNonEmptyString(entry.access);
  const refresh = asNonEmptyString(entry.refresh);
  if (!access && !refresh) return null;

  return {
    ...entry,
    type: 'oauth',
    ...(access ? { access } : {}),
    ...(refresh ? { refresh } : {}),
    ...(entry.expires !== undefined ? { expires: entry.expires } : {}),
  };
};

// OpenCode stores the Kimi For Coding plans as `kimi-code-plan-cn` (kimi.com)
// and `kimi-code-plan-global` (kimi.ai). The China plan comes first: its key
// works at the api.kimi.com usage address, and a pre-split `kimi-for-coding`
// key left behind with a dead credential must not shadow it. The global plan
// stays last, as before, since its key is not known to work at that address.
const KIMI_AUTH_ALIASES = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global'];

const getKimiApiKey = (auth: AuthFile) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, KIMI_AUTH_ALIASES));
  return asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);
};

const getHyperApiKey = (auth: AuthFile) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['hyper']));
  return asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);
};

const getKiloAuthEntry = (auth: AuthFile) => normalizeAuthEntry(getAuthEntry(auth, KILO_AUTH_ALIASES));

const getKiloApiKey = (auth: AuthFile) => {
  const entry = getKiloAuthEntry(auth);
  return asNonEmptyString(entry?.key)
    ?? asNonEmptyString(entry?.token)
    ?? asNonEmptyString(entry?.access);
};

const resolveGeminiCliAuth = (auth: AuthFile): GoogleAuthSource | null => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['google', 'google.oauth'])) as Record<string, unknown> | null;
  const entryObject = asObject(entry);
  if (!entryObject) {
    return null;
  }

  const oauthObject = asObject(entryObject.oauth) ?? entryObject;
  const accessToken = asNonEmptyString(oauthObject.access) ?? asNonEmptyString(oauthObject.token);
  const refreshParts = parseGoogleRefreshToken(oauthObject.refresh);

  if (!accessToken && !refreshParts.refreshToken) {
    return null;
  }

  return {
    sourceId: 'gemini',
    sourceLabel: 'Gemini',
    accessToken: accessToken ?? undefined,
    refreshToken: refreshParts.refreshToken ?? undefined,
    projectId: (refreshParts.projectId ?? refreshParts.managedProjectId) ?? undefined,
    expires: toTimestamp(oauthObject.expires) ?? undefined,
  };
};

const resolveAntigravityAuth = (): GoogleAuthSource | null => {
  for (const filePath of ANTIGRAVITY_ACCOUNTS_PATHS) {
    const data = readJsonFile(filePath);
    const accounts = data?.accounts;
    if (Array.isArray(accounts) && accounts.length > 0) {
      const index = typeof (data as Record<string, unknown>)?.activeIndex === 'number'
        ? (data as Record<string, unknown>).activeIndex as number
        : 0;
      const account = (accounts[index] as Record<string, unknown> | undefined) ?? (accounts[0] as Record<string, unknown> | undefined);
      if (account?.refreshToken) {
        const refreshParts = parseGoogleRefreshToken(account.refreshToken);
        return {
          sourceId: 'antigravity',
          sourceLabel: 'Antigravity',
          refreshToken: refreshParts.refreshToken ?? undefined,
          projectId: asNonEmptyString(account.projectId)
            ?? asNonEmptyString(account.managedProjectId)
            ?? refreshParts.projectId
            ?? refreshParts.managedProjectId
            ?? undefined,
          email: asNonEmptyString(account.email) ?? undefined,
        };
      }
    }
  }

  return null;
};

/**
 * Providers with a usable credential. Throws when OpenCode's credentials
 * cannot be read, so a transient failure does not look like "nothing
 * configured".
 */
export const listConfiguredQuotaProviders = async () => {
  const auth = await readOpenCodeCredentials();
  const configured = new Set<string>();
  const openCodeGoAuth = normalizeAuthEntry(getAuthEntry(auth, ['opencode-go']));
  if (openCodeGoAuth && (typeof openCodeGoAuth.key === 'string' || typeof openCodeGoAuth.token === 'string')) configured.add('opencode-go');
  if (readCredential('ollama-cloud')) configured.add('ollama-cloud');
  if (readCredential('cursor')) configured.add('cursor');
  if (readCredential('exe-dev')) configured.add('exe-dev');

  const anthropicAuth = normalizeAuthEntry(getAuthEntry(auth, ['anthropic', 'claude']));
  if (anthropicAuth && ((anthropicAuth as Record<string, unknown>).access || (anthropicAuth as Record<string, unknown>).token)) {
    configured.add('claude');
  }

  const openaiAuth = normalizeAuthEntry(getAuthEntry(auth, ['openai', 'codex', 'chatgpt']));
  if (openaiAuth && ((openaiAuth as Record<string, unknown>).access || (openaiAuth as Record<string, unknown>).token)) {
    configured.add('codex');
  }

  if (resolveGeminiCliAuth(auth) || resolveAntigravityAuth()) {
    configured.add('google');
  }

  const zaiAuth = normalizeAuthEntry(getAuthEntry(auth, ['zai-coding-plan', 'zai', 'z.ai']));
  if (zaiAuth && ((zaiAuth as Record<string, unknown>).key || (zaiAuth as Record<string, unknown>).token)) {
    configured.add('zai-coding-plan');
  }

  const zhipuaiAuth = normalizeAuthEntry(getAuthEntry(auth, ['zhipuai-coding-plan']));
  if (zhipuaiAuth && ((zhipuaiAuth as Record<string, unknown>).key || (zhipuaiAuth as Record<string, unknown>).token)) {
    configured.add('zhipuai-coding-plan');
  }

  if (getKimiApiKey(auth)) {
    configured.add('kimi-for-coding');
  }

  const minimaxAuth = normalizeAuthEntry(getAuthEntry(auth, ['minimax-coding-plan']));
  if (minimaxAuth && ((minimaxAuth as Record<string, unknown>).key || (minimaxAuth as Record<string, unknown>).token)) {
    configured.add('minimax-coding-plan');
  }

  const minimaxCnAuth = normalizeAuthEntry(getAuthEntry(auth, ['minimax-cn-coding-plan']));
  if (minimaxCnAuth && ((minimaxCnAuth as Record<string, unknown>).key || (minimaxCnAuth as Record<string, unknown>).token)) {
    configured.add('minimax-cn-coding-plan');
  }

  const openrouterAuth = normalizeAuthEntry(getAuthEntry(auth, ['openrouter']));
  if (openrouterAuth && ((openrouterAuth as Record<string, unknown>).key || (openrouterAuth as Record<string, unknown>).token)) {
    configured.add('openrouter');
  }

  const nanopgAuth = normalizeAuthEntry(getAuthEntry(auth, ['nano-gpt', 'nanogpt', 'nano_gpt']));
  if (nanopgAuth && ((nanopgAuth as Record<string, unknown>).key || (nanopgAuth as Record<string, unknown>).token)) {
    configured.add('nano-gpt');
  }

  const copilotAuth = normalizeAuthEntry(getAuthEntry(auth, ['github-copilot', 'copilot']));
  if (copilotAuth && ((copilotAuth as Record<string, unknown>).access || (copilotAuth as Record<string, unknown>).token)) {
    configured.add('github-copilot');
    configured.add('github-copilot-addon');
  }

  const waferAuth = normalizeAuthEntry(getAuthEntry(auth, ['wafer', 'wafer-ai', 'wafer_ai', 'wafer.ai']));
  if (waferAuth && ((waferAuth as Record<string, unknown>).key || (waferAuth as Record<string, unknown>).token)) {
    configured.add('wafer');
  }

  const clineAuth = normalizeAuthEntry(getAuthEntry(auth, ['cline-pass']));
  if (clineAuth && (asNonEmptyString(clineAuth.key) || asNonEmptyString(clineAuth.token))) {
    configured.add('cline-pass');
  }

  const neuralwattAuth = normalizeAuthEntry(getAuthEntry(auth, ['neuralwatt']));
  if (neuralwattAuth && ((neuralwattAuth as Record<string, unknown>).key || (neuralwattAuth as Record<string, unknown>).token)) {
    configured.add('neuralwatt');
  }

  const deepseekAuth = normalizeAuthEntry(getAuthEntry(auth, ['deepseek']));
  if (deepseekAuth && ((deepseekAuth as Record<string, unknown>).key || (deepseekAuth as Record<string, unknown>).token)) {
    configured.add('deepseek');
  }

  const deepinfraAuth = normalizeAuthEntry(getAuthEntry(auth, ['deepinfra', 'deep-infra', 'deep_infra']));
  if (deepinfraAuth && ((deepinfraAuth as Record<string, unknown>).key || (deepinfraAuth as Record<string, unknown>).token)) {
    configured.add('deepinfra');
  }

  if (getHyperApiKey(auth)) {
    configured.add('hyper');
  }

  if (asNonEmptyString(readCredential('zenmux')?.platformApiKey)) {
    configured.add('zenmux');
  }

  if (getKiloApiKey(auth)) {
    configured.add('kilo');
  }

  if (resolveXaiAuth(auth)) {
    configured.add('xai');
  }

  return Array.from(configured);
};

// --- Claude ----------------------------------------------------------------
// Kept local: the web provider reads Claude Code's Keychain / credentials file
// and CLAUDE_CODE_OAUTH_TOKEN before the OpenCode entry; the extension reads
// only the OpenCode entry.

const CLAUDE_DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const CLAUDE_MAX_COOLDOWN_MS = 60 * 60 * 1000;
let claudeCredentialFingerprint: string | null = null;
let claudeCachedUsage: ProviderUsage | null = null;
let claudeCooldownUntil = 0;

const claudeCooldownFromResponse = (response: Response): number => {
  const raw = response.headers.get('retry-after');
  const seconds = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, CLAUDE_MAX_COOLDOWN_MS);
  }
  if (raw) {
    const retryAt = Date.parse(raw);
    if (Number.isFinite(retryAt) && retryAt > Date.now()) {
      return Math.min(retryAt - Date.now(), CLAUDE_MAX_COOLDOWN_MS);
    }
  }
  return CLAUDE_DEFAULT_COOLDOWN_MS;
};

const buildClaudeRateLimitResult = (): ProviderResult => (
  claudeCachedUsage
    ? buildResult({
        providerId: 'claude',
        providerName: 'Claude',
        ok: true,
        configured: true,
        usage: claudeCachedUsage,
      })
    : buildResult({
        providerId: 'claude',
        providerName: 'Claude',
        ok: false,
        configured: true,
        error: 'Rate limited. Retrying soon.',
      })
);

const buildClaudeUsage = (payload: Record<string, unknown>): ProviderUsage => {
  const windows: Record<string, UsageWindow> = {};
  const models: Record<string, ProviderUsage> = {};
  const limits = Array.isArray(payload.limits) ? payload.limits : [];

  for (const entry of limits) {
    const limit = asObject(entry);
    if (!limit) continue;
    const usedPercent = toNumber(limit.percent);
    const resetAt = toTimestamp(limit.resets_at);
    if (limit.kind === 'session') {
      windows['5h'] = toUsageWindow({ usedPercent, windowSeconds: 5 * 60 * 60, resetAt });
    } else if (limit.kind === 'weekly_all') {
      windows['7d'] = toUsageWindow({ usedPercent, windowSeconds: 7 * 24 * 60 * 60, resetAt });
    } else if (limit.kind === 'weekly_scoped') {
      const modelName = asNonEmptyString(asObject(asObject(limit.scope)?.model)?.display_name);
      if (modelName) {
        models[modelName] = {
          windows: {
            '7d': toUsageWindow({ usedPercent, windowSeconds: 7 * 24 * 60 * 60, resetAt }),
          },
        };
      }
    }
  }

  if (!limits.length) {
    const fiveHour = asObject(payload.five_hour);
    const sevenDay = asObject(payload.seven_day);
    if (fiveHour) {
      windows['5h'] = toUsageWindow({
        usedPercent: toNumber(fiveHour.utilization),
        windowSeconds: 5 * 60 * 60,
        resetAt: toTimestamp(fiveHour.resets_at),
      });
    }
    if (sevenDay) {
      windows['7d'] = toUsageWindow({
        usedPercent: toNumber(sevenDay.utilization),
        windowSeconds: 7 * 24 * 60 * 60,
        resetAt: toTimestamp(sevenDay.resets_at),
      });
    }
  }

  const spend = asObject(payload.spend);
  if (spend?.enabled === true) {
    const usedMoney = asObject(spend.used);
    const limitMoney = asObject(spend.limit);
    const usedMinor = toNumber(usedMoney?.amount_minor);
    const limitMinor = toNumber(limitMoney?.amount_minor);
    const exponent = toNumber(usedMoney?.exponent) ?? 2;
    const currency = asNonEmptyString(usedMoney?.currency);
    const prefix = currency === 'USD' || !currency ? '$' : `${currency} `;
    const used = usedMinor === null ? null : usedMinor / 10 ** exponent;
    const limit = limitMinor === null ? null : limitMinor / 10 ** (toNumber(limitMoney?.exponent) ?? 2);
    windows.extra_usage = toUsageWindow({
      usedPercent: toNumber(spend.percent),
      windowSeconds: null,
      resetAt: null,
      valueLabel: used === null ? null : `${prefix}${formatMoney(used)}${limit === null ? '' : ` / ${prefix}${formatMoney(limit)}`}`,
    });
  }

  return Object.keys(models).length ? { windows, models } : { windows };
};

const fetchClaudeQuota = async (): Promise<ProviderResult> => {
  const auth = await readOpenCodeCredentials();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['anthropic', 'claude'])) as Record<string, unknown> | null;
  const accessToken = (entry?.access as string | undefined) ?? (entry?.token as string | undefined);

  if (!accessToken) {
    return buildResult({
      providerId: 'claude',
      providerName: 'Claude',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const refreshToken = typeof entry?.refresh === 'string' ? entry.refresh : '';
  const fingerprint = `${accessToken}\0${refreshToken}`;
  if (claudeCredentialFingerprint !== fingerprint) {
    claudeCredentialFingerprint = fingerprint;
    claudeCachedUsage = null;
    claudeCooldownUntil = 0;
  }
  if (Date.now() < claudeCooldownUntil) return buildClaudeRateLimitResult();

  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });

    if (response.status === 429) {
      claudeCooldownUntil = Date.now() + claudeCooldownFromResponse(response);
      return buildClaudeRateLimitResult();
    }

    if (response.status === 401 || response.status === 403) {
      return buildResult({
        providerId: 'claude',
        providerName: 'Claude',
        ok: false,
        configured: true,
        error: 'Claude session expired. Open Claude Code to sign in again.',
      });
    }

    if (!response.ok) {
      return buildResult({
        providerId: 'claude',
        providerName: 'Claude',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as Record<string, unknown>;
    const usage = buildClaudeUsage(payload);
    claudeCachedUsage = usage;
    return buildResult({
      providerId: 'claude',
      providerName: 'Claude',
      ok: true,
      configured: true,
      usage,
    });
  } catch (error) {
    return buildResult({
      providerId: 'claude',
      providerName: 'Claude',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

// --- Cursor ----------------------------------------------------------------
// Kept local: the web provider reads Cursor env/token files, refreshes an
// expired token and persists the result; the extension reads only its managed
// credential.

const CURSOR_BASE_URL = 'https://api2.cursor.sh';

const fetchCursorConnect = async (path: string, accessToken: string, body: Record<string, unknown> | null): Promise<Record<string, unknown>> => {
  const response = await fetch(`${CURSOR_BASE_URL}/${path}`, body === null
    ? { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000) }
    : { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(response.status === 401 ? 'Cursor session expired' : `API error: ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
};

const cursorRequestUsage = (authUsage: unknown): { used: number; limit: number } | null => {
  let best: { used: number; limit: number } | null = null;
  for (const [key, entry] of Object.entries((authUsage ?? {}) as Record<string, Record<string, unknown>>)) {
    if (key === 'startOfMonth' || !entry) continue;
    const used = toNumber(entry.numRequests);
    const limit = toNumber(entry.maxRequestUsage);
    if (used === null || !limit) continue;
    if (!best || limit > best.limit) best = { used, limit };
  }
  return best;
};

const cursorTeamMemberSpend = (teamSpend: unknown, userId: unknown): Record<string, unknown> | null => {
  const id = toNumber(userId);
  const members = (teamSpend as Record<string, unknown> | null | undefined)?.teamMemberSpend;
  if (id === null || !Array.isArray(members)) return null;
  return (members as Array<Record<string, unknown>>).find((member) => toNumber(member?.userId) === id) ?? null;
};

const cursorCreditsWindow = (credits: Record<string, unknown> | null): UsageWindow | null => {
  const balance = toNumber(credits?.balanceCents ?? credits?.totalBalanceCents ?? credits?.amountCents);
  return balance === null ? null : toUsageWindow({ usedPercent: null, windowSeconds: null, resetAt: null, valueLabel: `$${formatMoney(balance / 100)}` });
};

const cursorEnterpriseWindows = (usage: Record<string, unknown> | null, plan: Record<string, unknown> | null, authUsage: Record<string, unknown> | null, hardLimit: Record<string, unknown> | null, memberSpend: Record<string, unknown> | null): Record<string, UsageWindow> => {
  const resetAt = toTimestamp((plan?.planInfo as Record<string, unknown> | undefined)?.billingCycleEnd ?? usage?.billingCycleEnd);
  const windowSeconds = resetAt ? Math.max(0, Math.floor((resetAt - Date.now()) / 1000)) : null;
  const windows: Record<string, UsageWindow> = {};
  const requestUsage = cursorRequestUsage(authUsage);
  if (requestUsage) {
    windows.billing_cycle = toUsageWindow({ usedPercent: Math.min(100, Math.max(0, (requestUsage.used / requestUsage.limit) * 100)), windowSeconds, resetAt, valueLabel: `${Math.round(requestUsage.used)} / ${Math.round(requestUsage.limit)}` });
  }
  const limitDollars = toNumber(hardLimit?.hardLimitPerUser);
  const usedCents = toNumber(memberSpend?.spendCents);
  if (limitDollars !== null && limitDollars > 0 && usedCents !== null) {
    windows.on_demand = toUsageWindow({ usedPercent: Math.min(100, Math.max(0, (usedCents / (limitDollars * 100)) * 100)), windowSeconds, resetAt, valueLabel: `$${formatMoney(usedCents / 100)} / $${formatMoney(limitDollars)}` });
  }
  return windows;
};

const fetchCursorQuota = async (): Promise<ProviderResult> => {
  const accessToken = readCredential('cursor')?.accessToken;
  if (!accessToken) return buildResult({ providerId: 'cursor', providerName: 'Cursor', ok: false, configured: false, error: 'Not configured' });
  try {
    const post = (path: string, body: Record<string, unknown> = {}) => fetchCursorConnect(path, accessToken, body);
    const get = (path: string) => fetchCursorConnect(path, accessToken, null);
    const [usage, plan, credits] = await Promise.all([
      post('aiserver.v1.DashboardService/GetCurrentPeriodUsage'),
      post('aiserver.v1.DashboardService/GetPlanInfo').catch(() => null),
      post('aiserver.v1.DashboardService/GetCreditGrantsBalance').catch(() => null),
    ]);
    if (usage?.enabled === false) return buildResult({ providerId: 'cursor', providerName: 'Cursor', ok: false, configured: true, error: 'No active Cursor subscription' });
    if (!usage?.planUsage) {
      const profile = await get('auth/full_stripe_profile').catch(() => null);
      const teamId = profile?.teamId ? String(profile.teamId) : null;
      const teamBody = teamId ? { teamId } : {};
      const [authUsage, hardLimit, teamSpend, me] = await Promise.all([
        get('auth/usage').catch(() => null),
        post('aiserver.v1.DashboardService/GetHardLimit', teamBody).catch(() => null),
        teamId ? post('aiserver.v1.DashboardService/GetTeamSpend', teamBody).catch(() => null) : null,
        post('aiserver.v1.DashboardService/GetMe').catch(() => null),
      ]);
      const windows = cursorEnterpriseWindows(usage, plan, authUsage, hardLimit, cursorTeamMemberSpend(teamSpend, me?.userId));
      if (!windows.billing_cycle && !windows.on_demand) {
        return buildResult({ providerId: 'cursor', providerName: 'Cursor', ok: false, configured: true, error: 'No active Cursor subscription' });
      }
      const creditWindow = cursorCreditsWindow(credits);
      if (creditWindow) windows.credits = creditWindow;
      const planName = (plan?.planInfo as Record<string, unknown> | undefined)?.planName;
      return buildResult({ providerId: 'cursor', providerName: planName ? `Cursor ${String(planName)}` : 'Cursor', ok: true, configured: true, usage: { windows } });
    }
    const planUsage = (usage.planUsage as Record<string, unknown> | undefined) ?? {};
    const usedPercent = toNumber(planUsage.totalPercentUsed);
    return buildResult({ providerId: 'cursor', providerName: 'Cursor', ok: true, configured: true, usage: { windows: { billing_cycle: toUsageWindow({ usedPercent, windowSeconds: null, resetAt: toTimestamp(usage.billingCycleEnd) }) } } });
  } catch (error) { return buildResult({ providerId: 'cursor', providerName: 'Cursor', ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' }); }
};

// --- MiniMax ---------------------------------------------------------------
// Kept local: the web provider tries the M3 `/v1/token_plan/remains` endpoint
// first and handles remaining-percent/status fields; the extension still calls
// the legacy `coding_plan/remains` endpoint only.

const fetchMiniMaxQuota = async (data: {
  providerId: 'minimax-coding-plan' | 'minimax-cn-coding-plan';
  providerName: string;
  endpoint: string;
  usageFieldsAreRemaining: boolean;
}): Promise<ProviderResult> => {
  const auth = await readOpenCodeCredentials();
  const entry = normalizeAuthEntry(getAuthEntry(auth, [data.providerId])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

  if (!apiKey) {
    return buildResult({
      providerId: data.providerId,
      providerName: data.providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch(data.endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: data.providerId,
        providerName: data.providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as Record<string, unknown>;
    const baseResp = asObject(payload.base_resp);
    const statusCode = toNumber(baseResp?.status_code);
    if (baseResp && statusCode !== 0) {
      return buildResult({
        providerId: data.providerId,
        providerName: data.providerName,
        ok: false,
        configured: true,
        error: asNonEmptyString(baseResp.status_msg) ?? `API error: ${statusCode}`,
      });
    }

    const modelRemains = Array.isArray(payload.model_remains) ? payload.model_remains : [];
    const firstModel = asObject(modelRemains[0]);
    if (!firstModel) {
      return buildResult({
        providerId: data.providerId,
        providerName: data.providerName,
        ok: false,
        configured: true,
        error: 'No model quota data available',
      });
    }

    const intervalTotal = toNumber(firstModel.current_interval_total_count);
    const intervalUsage = toNumber(firstModel.current_interval_usage_count);
    const intervalStartAt = toTimestamp(firstModel.start_time);
    const intervalResetAt = toTimestamp(firstModel.end_time);
    const weeklyTotal = toNumber(firstModel.current_weekly_total_count);
    const weeklyUsage = toNumber(firstModel.current_weekly_usage_count);
    const weeklyStartAt = toTimestamp(firstModel.weekly_start_time);
    const weeklyResetAt = toTimestamp(firstModel.weekly_end_time);

    const intervalUsed = data.usageFieldsAreRemaining && intervalTotal !== null && intervalUsage !== null
      ? intervalTotal - intervalUsage
      : intervalUsage;
    const weeklyUsed = data.usageFieldsAreRemaining && weeklyTotal !== null && weeklyUsage !== null
      ? weeklyTotal - weeklyUsage
      : weeklyUsage;

    const intervalUsedPercent = intervalTotal !== null && intervalTotal > 0 && intervalUsed !== null
      ? Math.max(0, Math.min(100, (intervalUsed / intervalTotal) * 100))
      : null;
    const intervalWindowSeconds = intervalStartAt && intervalResetAt && intervalResetAt > intervalStartAt
      ? Math.floor((intervalResetAt - intervalStartAt) / 1000)
      : null;
    const weeklyUsedPercent = weeklyTotal !== null && weeklyTotal > 0 && weeklyUsed !== null
      ? Math.max(0, Math.min(100, (weeklyUsed / weeklyTotal) * 100))
      : null;
    const weeklyWindowSeconds = weeklyStartAt && weeklyResetAt && weeklyResetAt > weeklyStartAt
      ? Math.floor((weeklyResetAt - weeklyStartAt) / 1000)
      : null;

    return buildResult({
      providerId: data.providerId,
      providerName: data.providerName,
      ok: true,
      configured: true,
      usage: {
        windows: {
          '5h': toUsageWindow({
            usedPercent: intervalUsedPercent,
            windowSeconds: intervalWindowSeconds,
            resetAt: intervalResetAt,
          }),
          weekly: toUsageWindow({
            usedPercent: weeklyUsedPercent,
            windowSeconds: weeklyWindowSeconds,
            resetAt: weeklyResetAt,
          }),
        },
      },
    });
  } catch (error) {
    return buildResult({
      providerId: data.providerId,
      providerName: data.providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

const fetchMiniMaxCodingPlanQuota = () => fetchMiniMaxQuota({
  providerId: 'minimax-coding-plan',
  providerName: 'MiniMax Coding Plan (minimax.io)',
  endpoint: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
  usageFieldsAreRemaining: false,
});

const fetchMiniMaxCnCodingPlanQuota = () => fetchMiniMaxQuota({
  providerId: 'minimax-cn-coding-plan',
  providerName: 'MiniMax Coding Plan (minimaxi.com)',
  endpoint: 'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains',
  usageFieldsAreRemaining: true,
});

// --- Zhipu AI Coding Plan --------------------------------------------------
// Kept local: the web provider also reads `provider.<alias>.options.apiKey`
// from opencode.json; the extension reads only the OpenCode auth entry.

const fetchZhipuaiCodingPlanQuota = async (): Promise<ProviderResult> => {
  const auth = await readOpenCodeCredentials();
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['zhipuai-coding-plan'])) as Record<string, unknown> | null;
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

  if (!apiKey) {
    return buildResult({
      providerId: 'zhipuai-coding-plan',
      providerName: 'Zhipu AI Coding Plan',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch('https://open.bigmodel.cn/api/monitor/usage/quota/limit', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'zhipuai-coding-plan',
        providerName: 'Zhipu AI Coding Plan',
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json() as ZhipuaiPayload;

    const failure = zhipuaiEnvelopeError(payload);
    if (failure) {
      return buildResult({
        providerId: 'zhipuai-coding-plan',
        providerName: 'Zhipu AI Coding Plan',
        ok: false,
        configured: true,
        error: failure,
      });
    }

    const limits = Array.isArray(payload?.data?.limits) ? payload.data.limits : [];

    const windows: Record<string, UsageWindow> = {};

    // The API renamed TOKENS_LIMIT to CREDIT_LIMIT; field semantics stayed the
    // same, so both limit types map to the same windows. Unit 3 marks hourly
    // blocks (5h), unit 6 weekly.
    for (const limit of limits.filter((entry) => entry?.type === 'TOKENS_LIMIT' || entry?.type === 'CREDIT_LIMIT')) {
      const windowSeconds = resolveWindowSeconds(limit as Record<string, unknown>);
      const windowLabel = resolveWindowLabel(windowSeconds);
      const resetAt = limit.nextResetTime ? normalizeTimestamp(limit.nextResetTime) : null;

      windows[windowLabel] = toUsageWindow({
        usedPercent: resolveZhipuaiUsedPercent(limit),
        windowSeconds,
        resetAt,
        valueLabel: formatZhipuaiCreditValueLabel(limit),
      });
    }

    // Handle TIME_LIMIT (MCP tools monthly window)
    const mcpToolsTimeLimit = limits.find((limit) => limit?.type === 'TIME_LIMIT');
    if (mcpToolsTimeLimit) {
      // TIME_LIMIT unit=5 means 1 month (30 days)
      const monthSeconds = 30 * 24 * 60 * 60;
      const resetAt = mcpToolsTimeLimit?.nextResetTime ? normalizeTimestamp(mcpToolsTimeLimit.nextResetTime) : null;
      const usedPercent = typeof mcpToolsTimeLimit?.percentage === 'number' ? mcpToolsTimeLimit.percentage : null;

      windows['MCP Tools'] = toUsageWindow({
        usedPercent,
        windowSeconds: monthSeconds,
        resetAt,
      });
    }

    return buildResult({
      providerId: 'zhipuai-coding-plan',
      providerName: 'Zhipu AI Coding Plan',
      ok: true,
      configured: true,
      usage: { windows },
      planLabel: payload?.data?.level || null,
    });
  } catch (error) {
    return buildResult({
      providerId: 'zhipuai-coding-plan',
      providerName: 'Zhipu AI Coding Plan',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

// --- Kilo Code -------------------------------------------------------------
// Kept local: the web provider injects the OpenCode config object
// (`readOpencodeConfig`), while this runtime injects the resolved organization
// id, and the extension's tests rely on that seam.

const KILO_BALANCE_URL = 'https://api.kilo.ai/api/profile/balance';
const KILO_AUTH_ALIASES = ['kilo', 'kilocode', 'kilo-code'];

const readKiloOrganizationIdFromUserConfig = (): string | null => {
  try {
    const configPath = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');
    if (!fs.existsSync(configPath)) return null;
    const parsed = asObject(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    const provider = asObject(parsed?.provider);
    const kilo = asObject(provider?.kilo) ?? asObject(provider?.kilocode);
    const options = asObject(kilo?.options);
    return asNonEmptyString(options?.kilocodeOrganizationId)
      ?? asNonEmptyString(options?.organizationId);
  } catch {
    return null;
  }
};

type KiloQuotaDependencies = {
  readAuth?: () => AuthFile | Promise<AuthFile>;
  readOrganizationId?: () => string | null;
  fetchImpl?: (url: string, options: RequestInit) => Promise<Response>;
};

export const fetchKiloQuota = async ({
  readAuth = readOpenCodeCredentials,
  readOrganizationId = readKiloOrganizationIdFromUserConfig,
  fetchImpl = fetch,
}: KiloQuotaDependencies = {}): Promise<ProviderResult> => {
  const auth = await readAuth();
  const entry = getKiloAuthEntry(auth);
  const apiKey = getKiloApiKey(auth);

  if (!apiKey) {
    return buildResult({
      providerId: 'kilo',
      providerName: 'Kilo Code',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const organizationId = asNonEmptyString(entry?.kilocodeOrganizationId)
    ?? asNonEmptyString(entry?.organizationId)
    ?? asNonEmptyString(entry?.accountId)
    ?? readOrganizationId();

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const headers = organizationId
      ? {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'identity',
          'x-kilocode-organizationid': organizationId,
        }
      : {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'identity',
        };

    const response = await fetchImpl(KILO_BALANCE_URL, {
      method: 'GET',
      headers,
      signal: timeoutSignal,
    });

    if (!response.ok) {
      return buildResult({
        providerId: 'kilo',
        providerName: 'Kilo Code',
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? 'Session expired — please re-authenticate with Kilo Code'
          : `API error: ${response.status}`,
      });
    }

    const payload = asObject(await response.json());
    const rawBalance = payload?.balance;
    const balance = toNumber(asNonEmptyString(rawBalance)
      ?? (Number.isFinite(rawBalance) ? rawBalance : null));

    if (balance === null) {
      return buildResult({
        providerId: 'kilo',
        providerName: 'Kilo Code',
        ok: false,
        configured: true,
        error: 'No quota data in response',
      });
    }

    const windows = {
      credits_balance: toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `$${formatMoney(balance)}`,
      }),
    };

    return buildResult({
      providerId: 'kilo',
      providerName: 'Kilo Code',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && (
      error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted)
    );
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId: 'kilo',
      providerName: 'Kilo Code',
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : isParseError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed'),
    });
  }
};

// --- Ollama Cloud ----------------------------------------------------------
// Kept local: the web provider reads the managed cookie itself, while this
// runtime injects `readCookie`/`fetchImpl` for credential validation and tests,
// and treats every non-OK response as an authentication failure.

export const fetchOllamaCloudQuota = async ({
  readCookie = () => readCredential('ollama-cloud')?.cookie,
  fetchImpl = fetch,
}: {
  readCookie?: () => string | undefined;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
} = {}): Promise<ProviderResult> => {
  const cookie = readCookie();

  if (!cookie) {
    return buildResult({
      providerId: 'ollama-cloud',
      providerName: 'Ollama Cloud',
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  try {
    const parsed = await fetchOllamaUsage(cookie, fetchImpl);
    const windows = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [
      key, toUsageWindow({ ...value, windowSeconds: null, resetAt: null }),
    ]));

    return buildResult({
      providerId: 'ollama-cloud',
      providerName: 'Ollama Cloud',
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    return buildResult({
      providerId: 'ollama-cloud',
      providerName: 'Ollama Cloud',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};

// --- Gift reset activation -------------------------------------------------

const ZAI_GIFT_RESET_USE_URL = 'https://api.z.ai/api/biz/customer-package-reset/use';
const ZAI_GIFT_RESET_TYPES = ['FIVE_HOUR', 'WEEK'] as const;
const ZAI_ALIASES = ['zai-coding-plan', 'zai', 'z.ai'];

export type QuotaGiftResetType = (typeof ZAI_GIFT_RESET_TYPES)[number];

type ZaiGiftResetUsePayload = {
  msg?: string;
  success?: boolean;
};

const activateZaiGiftReset = async (input: { recordId: number; resetType: QuotaGiftResetType }): Promise<void> => {
  const auth = await readOpenCodeCredentials();
  // SAFETY: auth.json is untyped storage; the cast only reads the optional
  // key/token fields and no other shape is consumed.
  const entry = normalizeAuthEntry(getAuthEntry(auth, ZAI_ALIASES)) as { key?: unknown; token?: unknown } | null;
  // SAFETY: a non-string key/token becomes an unusable bearer that the
  // !apiKey check rejects before any request leaves the host.
  const apiKey = (entry?.key as string | undefined) ?? (entry?.token as string | undefined);

  if (!apiKey) {
    throw new Error('Not configured');
  }
  if (!Number.isFinite(input.recordId) || !ZAI_GIFT_RESET_TYPES.includes(input.resetType)) {
    throw new Error('Invalid gift reset request');
  }

  const response = await fetch(ZAI_GIFT_RESET_USE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      targetType: 'PERSONAL',
      resetType: input.resetType,
      recordId: input.recordId,
      requestId: crypto.randomUUID(),
    }),
  });

  // SAFETY: response.json() is untyped; only success/msg are consumed and both
  // are re-checked before use.
  const payload = await response.json().catch(() => null) as ZaiGiftResetUsePayload | null;
  if (!response.ok || payload?.success !== true) {
    throw new Error(payload?.msg || `API error: ${response.status}`);
  }
};

export const activateQuotaGiftReset = async (
  providerId: string,
  input: { recordId: number; resetType: QuotaGiftResetType },
): Promise<void> => {
  if (!ZAI_ALIASES.includes(providerId)) {
    throw new Error('Unsupported provider');
  }
  await activateZaiGiftReset(input);
};

// --- Dispatcher ------------------------------------------------------------

const fetchQuotaForProviderUncoalesced = async (providerId: string): Promise<ProviderResult> => {
  switch (providerId) {
    case 'claude':
      return fetchClaudeQuota();
    case 'codex':
      return fetchCodexQuota();
    case 'github-copilot':
      return fetchCopilotQuota();
    case 'github-copilot-addon':
      return fetchCopilotAddonQuota();
    case 'google':
      return fetchGoogleQuota();
    case 'kimi-for-coding':
      return fetchKimiQuota();
    case 'nano-gpt':
      return fetchNanoGptQuota();
    case 'minimax-coding-plan':
      return fetchMiniMaxCodingPlanQuota();
    case 'minimax-cn-coding-plan':
      return fetchMiniMaxCnCodingPlanQuota();
    case 'ollama-cloud':
      return fetchOllamaCloudQuota();
    case 'exe-dev':
      return fetchExeDevQuota();
    case 'openrouter':
      return fetchOpenRouterQuota();
    case 'zai-coding-plan':
      return fetchZaiQuota();
    case 'zhipuai-coding-plan':
      return fetchZhipuaiCodingPlanQuota();
    case 'wafer':
      return fetchWaferQuota();
    case 'opencode-go':
      return fetchOpenCodeGoQuota();
    case 'cursor':
      return fetchCursorQuota();
    case 'cline-pass':
      return fetchClinePassQuota();
    case 'deepinfra':
      return fetchDeepinfraQuota();
    case 'deepseek':
      return fetchDeepseekQuota();
    case 'hyper':
      return fetchHyperQuota();
    case 'neuralwatt':
      return fetchNeuralwattQuota();
    case 'kilo':
      return fetchKiloQuota();
    case 'zenmux':
      return fetchZenmuxQuota();
    case 'xai':
      return fetchXaiQuota();
    default:
      return buildResult({
        providerId,
        providerName: providerId,
        ok: false,
        configured: false,
        error: 'Unsupported provider',
      });
  }
};

const pendingQuotaFetches = new Map<string, Promise<ProviderResult>>();

export const fetchQuotaForProvider = (providerId: string): Promise<ProviderResult> => {
  const existing = pendingQuotaFetches.get(providerId);
  if (existing) return existing;

  const pending = fetchQuotaForProviderUncoalesced(providerId).finally(() => {
    if (pendingQuotaFetches.get(providerId) === pending) pendingQuotaFetches.delete(providerId);
  });
  pendingQuotaFetches.set(providerId, pending);
  return pending;
};
