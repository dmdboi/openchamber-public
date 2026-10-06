import type * as net from 'node:net';

export const CONNECT_ATTEMPT_TIMEOUT_MS: number;

export function applyConnectAttemptTimeout(
  netModule?: Partial<Pick<typeof net, 'setDefaultAutoSelectFamilyAttemptTimeout'>>,
): boolean;
