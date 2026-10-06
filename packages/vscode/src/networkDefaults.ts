/**
 * Shared with packages/web/server/lib/network-defaults.js via esbuild bundling.
 * The web module is the canonical owner of the connection-attempt policy; keep
 * this a thin re-export so the extension host and every Node server entrypoint
 * cannot diverge.
 */
export { applyConnectAttemptTimeout } from '../../web/server/lib/network-defaults.js';
