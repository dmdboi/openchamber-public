/**
 * Shared with packages/api/server/lib/network-defaults.js via esbuild bundling.
 * The web module is the canonical owner of the connection-attempt policy; keep
 * this a thin re-export so the extension host and every Node server entrypoint
 * cannot diverge.
 */
export { applyConnectAttemptTimeout } from '../../api/server/lib/network-defaults.js';
