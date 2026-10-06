import type * as net from 'node:net';

import { applyConnectAttemptTimeout, CONNECT_ATTEMPT_TIMEOUT_MS } from './network-defaults.js';

// Compile-time-only consumer for the JSDoc contract on network-defaults.js.
// This file is listed in tsconfig.types.json and emits nothing; it proves the
// JSDoc-derived types callers see match the signatures the deleted sidecar
// declared.
type InjectedNet = Partial<Pick<typeof net, 'setDefaultAutoSelectFamilyAttemptTimeout'>>;

const acceptsInjectedNet: (netModule?: InjectedNet) => boolean = applyConnectAttemptTimeout;
const timeoutIsNumber: number = CONNECT_ATTEMPT_TIMEOUT_MS;
const acceptsEmptyPartial: boolean = applyConnectAttemptTimeout({});

export { acceptsEmptyPartial, acceptsInjectedNet, timeoutIsNumber };
