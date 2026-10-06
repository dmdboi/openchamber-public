import { z } from 'zod';

import { MCP_PROTOCOLS, type McpCodemodeChoice, type McpDraft, type McpProtocol } from '@/stores/useMcpConfigStore';

/**
 * A parsed JSON value. The importer reads untrusted paste content, so every
 * field is decoded through this domain type before it is interpreted.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
const stringArraySchema = z.array(z.string());
const stringSchema = z.string();
const numberSchema = z.number();

export interface ImportedMcpResult {
  readonly ok: true;
  readonly name?: string;
  readonly type: 'local' | 'remote';
  readonly command: string[];
  readonly url: string;
  readonly environment: Array<{ key: string; value: string }>;
  readonly headers: Array<{ key: string; value: string }>;
  readonly oauthEnabled: boolean;
  readonly oauthClientId: string;
  readonly oauthClientSecret: string;
  readonly oauthScope: string;
  readonly oauthRedirectUri: string;
  readonly oauthCallbackPort: string;
  readonly oauthAuthServerMetadataUrl: string;
  readonly timeoutStartup: string;
  readonly timeoutCatalog: string;
  readonly timeoutExecution: string;
  readonly codemode: McpCodemodeChoice;
  readonly disabled: boolean;
  /** Absent in the paste means legacy, as OpenCode reads it. */
  readonly protocol: McpProtocol;
}

type ImportedMcpError =
  | { readonly ok: false; readonly error: string }
  | { readonly ok: false; readonly error: string; readonly parsed: JsonValue };

export type ImportedMcpOutcome = ImportedMcpResult | ImportedMcpError;

/** Decode a JSON value as an object, or null when it is an array or primitive. */
function asJsonObject(value: JsonValue): JsonObject | null {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function asString(value: JsonValue): string | null {
  const parsed = stringSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function asNumber(value: JsonValue): number | null {
  const parsed = numberSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A JSON array whose every element is a string, or null otherwise. */
function asStringArray(value: JsonValue): string[] | null {
  const parsed = stringArraySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function buildError(message: string, parsed?: JsonValue): ImportedMcpError {
  return parsed !== undefined
    ? { ok: false, error: message, parsed }
    : { ok: false, error: message };
}

function buildResult(
  name: string | undefined,
  type: 'local' | 'remote',
  raw: JsonObject,
): ImportedMcpResult {
  const command: string[] = buildCommand(raw);
  const urlValue = asString(raw.url);
  const url = urlValue !== null ? urlValue.trim() : '';

  const environment = buildEnv(raw, 'env', 'environment');
  const headers = buildEnv(raw, 'headers');

  // OAuth is snake_case in v2 and camelCase in v1; both spellings are read.
  const oauth = asJsonObject(raw.oauth);
  const oauthClientId = readString(oauth, 'client_id', 'clientId');
  const oauthClientSecret = readString(oauth, 'client_secret', 'clientSecret');
  const oauthScope = readString(oauth, 'scope');
  const oauthRedirectUri = readString(oauth, 'redirect_uri', 'redirectUri');
  const oauthCallbackPort = readNumeric(oauth, 'callback_port', 'callbackPort');
  const oauthAuthServerMetadataUrl = readString(oauth, 'auth_server_metadata_url', 'authServerMetadataUrl');
  const oauthEnabled = raw.oauth === false || raw.oauth === null
    ? false
    : oauth !== null && Boolean(
      oauthClientId || oauthClientSecret || oauthScope || oauthRedirectUri || oauthCallbackPort || oauthAuthServerMetadataUrl,
    );

  const timeouts = buildTimeouts(raw);

  return {
    ok: true,
    name,
    type,
    command,
    url,
    environment,
    headers,
    oauthEnabled,
    oauthClientId,
    oauthClientSecret,
    oauthScope,
    oauthRedirectUri,
    oauthCallbackPort,
    oauthAuthServerMetadataUrl,
    timeoutStartup: timeouts.startup,
    timeoutCatalog: timeouts.catalog,
    timeoutExecution: timeouts.execution,
    codemode: raw.codemode === true ? 'on' : raw.codemode === false ? 'off' : 'default',
    disabled: buildDisabled(raw),
    protocol: MCP_PROTOCOLS.find((candidate) => candidate === raw.protocol) ?? 'legacy',
  };
}

/** First of the given keys that holds a non-empty string. */
function readString(source: JsonObject | null, ...keys: string[]): string {
  if (!source) return '';
  for (const key of keys) {
    const text = asString(source[key]);
    if (text !== null && text.trim()) return text.trim();
  }
  return '';
}

/** First of the given keys that reads as a positive whole number. */
function readNumeric(source: JsonObject | null, ...keys: string[]): string {
  if (!source) return '';
  for (const key of keys) {
    const parsed = positiveInteger(source[key]);
    if (parsed) return parsed;
  }
  return '';
}

function positiveInteger(value: JsonValue): string {
  const numeric = asNumber(value);
  if (numeric !== null && Number.isFinite(numeric) && numeric > 0) {
    return String(Math.floor(numeric));
  }
  const text = asString(value);
  if (text !== null && text.trim()) {
    const parsed = Number(text);
    if (Number.isFinite(parsed) && parsed > 0) return String(Math.floor(parsed));
  }
  return '';
}

function buildCommand(raw: JsonObject): string[] {
  const cmd = raw.command;
  const args = raw.args;
  const cmdArray = asStringArray(cmd);
  const argsArray = asStringArray(args);

  if (cmdArray && argsArray) {
    return [...cmdArray, ...argsArray];
  }
  if (cmdArray) {
    return cmdArray;
  }
  const cmdText = asString(cmd);
  if (cmdText !== null && cmdText.trim()) {
    const parts = cmdText.trim().split(/\s+/);
    if (argsArray) {
      return [...parts, ...argsArray];
    }
    return parts;
  }
  if (argsArray) {
    return argsArray;
  }

  return [];
}

function buildEnv(
  raw: JsonObject,
  ...keys: string[]
): Array<{ key: string; value: string }> {
  for (const key of keys) {
    const val = asJsonObject(raw[key]);
    if (!val) continue;

    const entries: Array<{ key: string; value: string }> = [];
    for (const [k, v] of Object.entries(val)) {
      if (!k) continue;
      const text = asString(v);
      if (text === null) continue;
      entries.push({ key: k, value: text });
    }
    if (entries.length > 0) {
      return entries;
    }
  }
  return [];
}

/**
 * v2 splits the timeout by phase; a v1 paste carries one number, which stood
 * for the whole request, so it lands on `execution`.
 */
function buildTimeouts(raw: JsonObject) {
  const timeout = asJsonObject(raw.timeout);
  if (timeout) {
    return {
      startup: positiveInteger(timeout.startup),
      catalog: positiveInteger(timeout.catalog),
      execution: positiveInteger(timeout.execution),
    };
  }
  return { startup: '', catalog: '', execution: positiveInteger(raw.timeout) };
}

/**
 * v2 uses `disabled`; a v1 paste says `enabled`. When neither is present the
 * server is active, which is what both versions mean by an absent flag.
 */
function buildDisabled(raw: JsonObject): boolean {
  if (raw.disabled === true) return true;
  if (raw.disabled === false) return false;
  if ('enabled' in raw) return !raw.enabled;
  return false;
}

/**
 * Extract a single named server entry from a parsed JSON object.
 * Returns null if the shape does not contain exactly one identifiable server.
 */
function extractSingleServer(
  obj: JsonObject,
): { name: string; entry: JsonObject } | null {
  const serverKeys = Object.keys(obj).filter((k) => {
    if (k === 'mcpServers') return false;
    return asJsonObject(obj[k]) !== null;
  });

  if (serverKeys.length === 1) {
    const name = serverKeys[0]!;
    const entry = asJsonObject(obj[name]);
    if (entry && isServerConfig(entry)) {
      return { name, entry };
    }
  }

  return null;
}

function isServerConfig(val: JsonObject): boolean {
  return (
    val.type === 'local' ||
    val.type === 'remote' ||
    Array.isArray(val.command) ||
    asString(val.url) !== null ||
    Array.isArray(val.args)
  );
}

/**
 * Parse a raw JSON string as an MCP server snippet and return a normalized
 * result or a structured error. Does not mutate the current draft — the caller
 * applies the result to form state. Both OpenCode versions are accepted; the
 * result is always in the v2 vocabulary.
 *
 * Supported shapes:
 *   { "mcpServers": { "name": { ... } } }   (Claude Desktop / generic)
 *   { "mcp": { "servers": { "name": { ... } } } }   (OpenCode 2)
 *   { "mcp": { "name": { ... } } }          (OpenCode 1)
 *   { "name": { ... } }
 *   { ...serverConfig }
 */
export function parseImportedMcpSnippet(
  raw: string,
  options?: { fallbackName?: string },
): ImportedMcpOutcome {
  let parsed: JsonValue;
  try {
    const trimmed = raw.trim();
    if (!trimmed) {
      return buildError('No JSON content provided');
    }
    parsed = jsonValueSchema.parse(JSON.parse(trimmed));
  } catch (err) {
    return buildError(
      err instanceof Error ? `Invalid JSON: ${err.message}` : 'Invalid JSON',
    );
  }

  const obj = asJsonObject(parsed);
  if (!obj) {
    return buildError('Expected a JSON object, not an array or primitive');
  }

  // Detect single named entry inside { "mcpServers": { "name": { ... } } }
  const mcpServers = asJsonObject(obj.mcpServers);
  if (mcpServers) {
    const keys = Object.keys(mcpServers);
    if (keys.length === 0) {
      return buildError('mcpServers object is empty', parsed);
    }
    if (keys.length > 1) {
      return buildError(
        'Paste one server at a time. Found ' +
          keys.length +
          ' servers in mcpServers',
        parsed,
      );
    }
    const serverName = keys[0]!;
    const entry = asJsonObject(mcpServers[serverName]);
    if (!entry) {
      return buildError('Server entry is not a valid object', parsed);
    }
    return buildResult(serverName, inferType(entry), entry);
  }

  // v2 config shape { "mcp": { "servers": { "name": { ... } } } }, and the v1
  // shape { "mcp": { "name": { ... } } } it replaced.
  const mcpSection = asJsonObject(obj.mcp);
  const mcpServersSection = mcpSection ? asJsonObject(mcpSection.servers) : null;
  const mcp = mcpServersSection ?? mcpSection;
  if (mcp) {
    const keys = Object.keys(mcp);
    if (keys.length === 0) {
      return buildError('mcp object is empty', parsed);
    }
    if (keys.length > 1) {
      return buildError(
        'Paste one server at a time. Found ' +
          keys.length +
          ' servers in mcp',
        parsed,
      );
    }
    const serverName = keys[0]!;
    const entry = asJsonObject(mcp[serverName]);
    if (!entry) {
      return buildError('Server entry in mcp is not a valid object', parsed);
    }
    return buildResult(serverName, inferType(entry), entry);
  }

  // Detect single named entry { "serverName": { ... } }
  const single = extractSingleServer(obj);
  if (single) {
    return buildResult(
      single.name,
      inferType(single.entry),
      single.entry,
    );
  }

  // Treat top-level as a bare server config
  if (isServerConfig(obj)) {
    const type = inferType(obj);
    const rawName = asString(obj.name);
    const name = rawName !== null && rawName.trim()
      ? rawName.trim()
      : options?.fallbackName;
    return buildResult(name, type, obj);
  }

  return buildError(
    'No recognizable MCP server configuration found in JSON',
    parsed,
  );
}

function inferType(entry: JsonObject): 'local' | 'remote' {
  if (entry.type === 'remote') return 'remote';
  if (entry.type === 'local') return 'local';
  const url = asString(entry.url);
  if (url !== null && url.trim()) return 'remote';
  if (Array.isArray(entry.command) || asString(entry.command) !== null) return 'local';
  if (Array.isArray(entry.args)) return 'local';
  return 'local';
}

/**
 * Apply an imported result to a new or existing McpDraft.
 * All fields from the result override the draft, but fields only
 * relevant to the opposite transport type are cleared.
 */
export function applyImportedMcpToDraft(
  result: ImportedMcpResult,
  currentDraft: Partial<McpDraft> & { name?: string },
  options?: { isNewServer?: boolean },
): Partial<McpDraft> & { name: string } {
  const isNew = options?.isNewServer ?? false;
  const importedName = result.name;
  const name = isNew && importedName ? importedName : currentDraft.name ?? '';

  const draft: Partial<McpDraft> & { name: string } = {
    ...currentDraft,
    name,
    type: result.type,
    command: result.type === 'local' ? result.command : [],
    url: result.type === 'remote' ? result.url : '',
    environment: result.environment,
    headers: result.type === 'remote' ? result.headers : [],
    oauthEnabled: result.type === 'remote' ? result.oauthEnabled : false,
    oauthClientId: result.type === 'remote' ? result.oauthClientId : '',
    oauthClientSecret: result.type === 'remote' ? result.oauthClientSecret : '',
    oauthScope: result.type === 'remote' ? result.oauthScope : '',
    oauthRedirectUri: result.type === 'remote' ? result.oauthRedirectUri : '',
    oauthCallbackPort: result.type === 'remote' ? result.oauthCallbackPort : '',
    oauthAuthServerMetadataUrl: result.type === 'remote' ? result.oauthAuthServerMetadataUrl : '',
    // `startup` only means something for a server OpenChamber spawns.
    timeoutStartup: result.type === 'local' ? result.timeoutStartup : '',
    timeoutCatalog: result.timeoutCatalog,
    timeoutExecution: result.timeoutExecution,
    codemode: result.codemode,
    disabled: result.disabled,
    protocol: result.protocol,
  };

  return draft;
}
