import { z } from 'zod';

import { hasDesktopInvoke, invokeDesktop } from '@/lib/desktop';

/**
 * A parsed JSON value. IPC payloads cross a process boundary, so every field is
 * decoded through this domain type before it is interpreted.
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
const stringSchema = z.string();
const numberSchema = z.number();
const booleanSchema = z.boolean();
const jsonArraySchema = z.array(jsonValueSchema);

type DesktopInvoke = (command: string, args?: JsonObject) => Promise<JsonValue>;

type DesktopBridgeGlobal = {
  listen?: (
    event: string,
    handler: (event: { payload?: JsonValue }) => void,
  ) => Promise<() => void>;
};

type DesktopSshRemoteMode = 'managed' | 'external';
type DesktopSshInstallMethod = 'auto' | 'npm' | 'bun';
type DesktopSshSecretStore = 'never' | 'settings';

type DesktopSshStoredSecret = {
  enabled: boolean;
  value?: string;
  store: DesktopSshSecretStore;
};

export type DesktopSshPortForwardType = 'local' | 'remote' | 'dynamic';

export type DesktopSshPortForward = {
  id: string;
  enabled: boolean;
  type: DesktopSshPortForwardType;
  localHost?: string;
  localPort?: number;
  remoteHost?: string;
  remotePort?: number;
};

export type DesktopSshInstance = {
  id: string;
  nickname?: string;
  sshCommand: string;
  sshParsed?: {
    destination: string;
    args: string[];
  };
  connectionTimeoutSec: number;
  remoteOpenchamber: {
    mode: DesktopSshRemoteMode;
    keepRunning: boolean;
    preferredPort?: number;
    /** Interface the managed remote server listens on. '0.0.0.0' also exposes it to the remote machine's network. */
    bindHost: '127.0.0.1' | '0.0.0.0';
    installMethod: DesktopSshInstallMethod;
    uploadBundleOverSsh: boolean;
  };
  localForward: {
    preferredLocalPort?: number;
    bindHost: '127.0.0.1' | 'localhost' | '0.0.0.0';
  };
  auth: {
    sshPassword?: DesktopSshStoredSecret;
    openchamberPassword?: DesktopSshStoredSecret;
  };
  portForwards: DesktopSshPortForward[];
};

type DesktopSshInstancesConfig = {
  instances: DesktopSshInstance[];
};

type DesktopSshPhase =
  | 'idle'
  | 'config_resolved'
  | 'auth_check'
  | 'master_connecting'
  | 'remote_probe'
  | 'installing'
  | 'updating'
  | 'server_detecting'
  | 'server_starting'
  | 'forwarding'
  | 'ready'
  | 'degraded'
  | 'error';

export type DesktopSshInstanceStatus = {
  id: string;
  phase: DesktopSshPhase;
  detail?: string;
  localUrl?: string;
  localPort?: number;
  remotePort?: number;
  startedByUs: boolean;
  retryAttempt: number;
  requiresUserAction: boolean;
  updatedAtMs: number;
};

export type DesktopSshImportCandidate = {
  host: string;
  pattern: boolean;
  source: string;
  sshCommand: string;
};

/** Decode a JSON value as an object, or null when it is an array or primitive. */
const asJsonObject = (value: JsonValue): JsonObject | null => {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const readString = (obj: JsonObject, key: string): string | null => {
  const parsed = stringSchema.safeParse(obj[key]);
  return parsed.success ? parsed.data : null;
};

const readNumber = (obj: JsonObject, key: string): number | null => {
  const parsed = numberSchema.safeParse(obj[key]);
  return parsed.success && Number.isFinite(parsed.data) ? parsed.data : null;
};

const readBoolean = (obj: JsonObject, key: string): boolean | null => {
  const parsed = booleanSchema.safeParse(obj[key]);
  return parsed.success ? parsed.data : null;
};

/** The string elements of a JSON array; non-arrays and non-string elements are dropped. */
const asStringArray = (value: JsonValue): string[] => {
  const parsed = jsonArraySchema.safeParse(value);
  if (!parsed.success) return [];
  const result: string[] = [];
  for (const item of parsed.data) {
    const text = stringSchema.safeParse(item);
    if (text.success) result.push(text.data);
  }
  return result;
};

const getInvoke = (): DesktopInvoke | null => {
  if (!hasDesktopInvoke()) return null;
  return (command, args) => invokeDesktop<JsonValue>(command, args);
};

const parseStoredSecret = (value: JsonValue): DesktopSshStoredSecret | undefined => {
  const raw = asJsonObject(value);
  if (!raw) return undefined;
  const enabled = readBoolean(raw, 'enabled') ?? false;
  const rawStore = readString(raw, 'store')?.toLowerCase();
  const store: DesktopSshSecretStore = rawStore === 'settings' ? 'settings' : 'never';
  const storedValue = readString(raw, 'value');
  const secret: DesktopSshStoredSecret = { enabled, store };
  if (storedValue) secret.value = storedValue;
  return secret;
};

const parseForwardType = (value: string | null): DesktopSshPortForwardType => {
  return value === 'remote' || value === 'dynamic' ? value : 'local';
};

const parseForward = (value: JsonValue): DesktopSshPortForward | null => {
  const raw = asJsonObject(value);
  if (!raw) return null;
  const id = readString(raw, 'id');
  if (!id) return null;
  const enabled = readBoolean(raw, 'enabled') ?? true;
  const type = parseForwardType(readString(raw, 'type'));
  const forward: DesktopSshPortForward = { id, enabled, type };
  const localHost = readString(raw, 'localHost') || readString(raw, 'local_host');
  if (localHost) forward.localHost = localHost;
  const localPort = readNumber(raw, 'localPort') ?? readNumber(raw, 'local_port');
  if (localPort !== null) forward.localPort = localPort;
  const remoteHost = readString(raw, 'remoteHost') || readString(raw, 'remote_host');
  if (remoteHost) forward.remoteHost = remoteHost;
  const remotePort = readNumber(raw, 'remotePort') ?? readNumber(raw, 'remote_port');
  if (remotePort !== null) forward.remotePort = remotePort;
  return forward;
};

const parseInstance = (value: JsonValue): DesktopSshInstance | null => {
  const raw = asJsonObject(value);
  if (!raw) return null;
  const id = readString(raw, 'id');
  const sshCommand = readString(raw, 'sshCommand') || readString(raw, 'ssh_command');
  if (!id || !sshCommand) return null;
  const nickname = readString(raw, 'nickname');

  const parsedRecord = asJsonObject(raw.sshParsed ?? null);
  const parsed = parsedRecord
    ? {
        destination: readString(parsedRecord, 'destination') || '',
        args: asStringArray(parsedRecord.args ?? null),
      }
    : undefined;

  const remoteRaw =
    asJsonObject(raw.remoteOpenchamber ?? null) ??
    asJsonObject(raw.remote_openchamber ?? null) ??
    {};

  const localRaw =
    asJsonObject(raw.localForward ?? null) ??
    asJsonObject(raw.local_forward ?? null) ??
    {};

  const authRaw = asJsonObject(raw.auth ?? null) ?? {};

  const rawMode = readString(remoteRaw, 'mode')?.toLowerCase();
  const mode: DesktopSshRemoteMode = rawMode === 'external' ? 'external' : 'managed';

  const rawInstallMethod = readString(remoteRaw, 'installMethod') || readString(remoteRaw, 'install_method');
  // Legacy 'download_release'/'upload_bundle' never had their own remote path:
  // they fell through to the same bun-then-npm attempt as 'auto'. Read them as
  // 'auto' so the stored value matches what actually happens.
  const installMethod: DesktopSshInstallMethod =
    rawInstallMethod === 'npm' || rawInstallMethod === 'bun' ? rawInstallMethod : 'auto';

  const bindHostRaw =
    readString(localRaw, 'bindHost') ||
    readString(localRaw, 'bind_host') ||
    '127.0.0.1';
  const bindHost: '127.0.0.1' | 'localhost' | '0.0.0.0' =
    bindHostRaw === 'localhost' || bindHostRaw === '0.0.0.0' ? bindHostRaw : '127.0.0.1';

  const forwardsRaw = Array.isArray(raw.portForwards)
    ? raw.portForwards
    : Array.isArray(raw.port_forwards)
      ? raw.port_forwards
      : [];

  const portForwards = forwardsRaw
    .map((item) => parseForward(item))
    .filter((item): item is DesktopSshPortForward => Boolean(item));

  const preferredPort = readNumber(remoteRaw, 'preferredPort') ?? readNumber(remoteRaw, 'preferred_port');
  const rawRemoteBindHost = readString(remoteRaw, 'bindHost') || readString(remoteRaw, 'bind_host');
  const remoteBindHost: '127.0.0.1' | '0.0.0.0' = rawRemoteBindHost === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  const preferredLocalPort =
    readNumber(localRaw, 'preferredLocalPort') ?? readNumber(localRaw, 'preferred_local_port');
  const sshPassword = parseStoredSecret(authRaw.sshPassword || authRaw.ssh_password || null);
  const openchamberPassword = parseStoredSecret(authRaw.openchamberPassword || authRaw.openchamber_password || null);

  const remoteOpenchamber: DesktopSshInstance['remoteOpenchamber'] = {
    mode,
    keepRunning: readBoolean(remoteRaw, 'keepRunning') ?? readBoolean(remoteRaw, 'keep_running') ?? true,
    bindHost: remoteBindHost,
    installMethod,
    uploadBundleOverSsh:
      readBoolean(remoteRaw, 'uploadBundleOverSsh') ??
      readBoolean(remoteRaw, 'upload_bundle_over_ssh') ??
      false,
  };
  if (preferredPort) remoteOpenchamber.preferredPort = preferredPort;

  const localForward: DesktopSshInstance['localForward'] = { bindHost };
  if (preferredLocalPort) localForward.preferredLocalPort = preferredLocalPort;

  const auth: DesktopSshInstance['auth'] = {};
  if (sshPassword) auth.sshPassword = sshPassword;
  if (openchamberPassword) auth.openchamberPassword = openchamberPassword;

  const instance: DesktopSshInstance = {
    id,
    sshCommand,
    connectionTimeoutSec:
      readNumber(raw, 'connectionTimeoutSec') ??
      readNumber(raw, 'connection_timeout_sec') ??
      60,
    remoteOpenchamber,
    localForward,
    auth,
    portForwards,
  };
  if (nickname) instance.nickname = nickname;
  if (parsed && parsed.destination) instance.sshParsed = parsed;
  return instance;
};

const parsePhase = (value: string | null): DesktopSshPhase => {
  switch (value) {
    case 'config_resolved':
    case 'auth_check':
    case 'master_connecting':
    case 'remote_probe':
    case 'installing':
    case 'updating':
    case 'server_detecting':
    case 'server_starting':
    case 'forwarding':
    case 'ready':
    case 'degraded':
    case 'error':
      return value;
    default:
      return 'idle';
  }
};

const parseStatus = (value: JsonValue): DesktopSshInstanceStatus | null => {
  const raw = asJsonObject(value);
  if (!raw) return null;
  const id = readString(raw, 'id');
  if (!id) return null;
  const status: DesktopSshInstanceStatus = {
    id,
    phase: parsePhase(readString(raw, 'phase')),
    startedByUs: readBoolean(raw, 'startedByUs') ?? readBoolean(raw, 'started_by_us') ?? false,
    retryAttempt: readNumber(raw, 'retryAttempt') ?? readNumber(raw, 'retry_attempt') ?? 0,
    requiresUserAction:
      readBoolean(raw, 'requiresUserAction') ?? readBoolean(raw, 'requires_user_action') ?? false,
    updatedAtMs: readNumber(raw, 'updatedAtMs') ?? readNumber(raw, 'updated_at_ms') ?? Date.now(),
  };
  const detail = readString(raw, 'detail');
  if (detail) status.detail = detail;
  const localUrl = readString(raw, 'localUrl') || readString(raw, 'local_url');
  if (localUrl) status.localUrl = localUrl;
  const localPort = readNumber(raw, 'localPort') ?? readNumber(raw, 'local_port');
  if (localPort !== null) status.localPort = localPort;
  const remotePort = readNumber(raw, 'remotePort') ?? readNumber(raw, 'remote_port');
  if (remotePort !== null) status.remotePort = remotePort;
  return status;
};

const parseImportCandidate = (value: JsonValue): DesktopSshImportCandidate | null => {
  const raw = asJsonObject(value);
  if (!raw) return null;
  const host = readString(raw, 'host');
  const source = readString(raw, 'source');
  const sshCommand = readString(raw, 'sshCommand') || readString(raw, 'ssh_command');
  if (!host || !source || !sshCommand) return null;
  return {
    host,
    source,
    sshCommand,
    pattern: readBoolean(raw, 'pattern') ?? false,
  };
};

export const createDesktopSshInstance = (id: string, sshCommand: string): DesktopSshInstance => {
  return {
    id,
    sshCommand,
    connectionTimeoutSec: 60,
    remoteOpenchamber: {
      mode: 'managed',
      keepRunning: true,
      bindHost: '127.0.0.1',
      installMethod: 'auto',
      uploadBundleOverSsh: false,
    },
    localForward: {
      bindHost: '127.0.0.1',
    },
    auth: {},
    portForwards: [],
  };
};

export const desktopSshInstancesGet = async (): Promise<DesktopSshInstancesConfig> => {
  const invoke = getInvoke();
  if (!invoke) {
    return { instances: [] };
  }

  const raw = await invoke('desktop_ssh_instances_get');
  const root = asJsonObject(raw);
  if (!root) {
    return { instances: [] };
  }

  const listRaw = Array.isArray(root.instances)
    ? root.instances
    : Array.isArray(root.desktopSshInstances)
      ? root.desktopSshInstances
      : [];

  const instances = listRaw
    .map((item) => parseInstance(item))
    .filter((item): item is DesktopSshInstance => Boolean(item));

  return { instances };
};

export const desktopSshInstancesSet = async (config: DesktopSshInstancesConfig): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_ssh_instances_set', {
    config: {
      instances: config.instances,
    },
  });
};

export const desktopSshImportHosts = async (): Promise<DesktopSshImportCandidate[]> => {
  const invoke = getInvoke();
  if (!invoke) return [];
  const raw = await invoke('desktop_ssh_import_hosts');
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => parseImportCandidate(item))
    .filter((item): item is DesktopSshImportCandidate => Boolean(item));
};

export const desktopSshConnect = async (id: string): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_ssh_connect', { id });
};

export const desktopSshDisconnect = async (id: string): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_ssh_disconnect', { id });
};

export const desktopSshStatus = async (id?: string): Promise<DesktopSshInstanceStatus[]> => {
  const invoke = getInvoke();
  if (!invoke) return [];
  const args: JsonObject = {};
  if (id) args.id = id;
  const raw = await invoke('desktop_ssh_status', args);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => parseStatus(item))
    .filter((item): item is DesktopSshInstanceStatus => Boolean(item));
};

export const desktopSshLogs = async (id: string, limit?: number): Promise<string[]> => {
  const invoke = getInvoke();
  if (!invoke) return [];
  const args: JsonObject = { id };
  if (limit !== undefined) args.limit = limit;
  const raw = await invoke('desktop_ssh_logs', args);
  return asStringArray(raw);
};

export const desktopSshLogsClear = async (id: string): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_ssh_logs_clear', { id });
};

export const listenDesktopSshStatus = async (
  listener: (status: DesktopSshInstanceStatus) => void,
): Promise<() => Promise<void>> => {
  if (!hasDesktopInvoke()) {
    return async () => {};
  }

  // SAFETY: the preload script installs this global before any renderer code
  // runs; its shape is the bridge contract declared above.
  const desktop = (window as Window & { __OPENCHAMBER_DESKTOP__?: DesktopBridgeGlobal }).__OPENCHAMBER_DESKTOP__;
  const listen = desktop?.listen;
  if (!listen) {
    return async () => {};
  }

  const unlisten = await listen('openchamber:ssh-instance-status', (event) => {
    const status = parseStatus(event?.payload ?? null);
    if (!status) return;
    listener(status);
  });

  return async () => {
    await unlisten();
  };
};
