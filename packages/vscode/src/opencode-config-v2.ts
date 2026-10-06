/**
 * Shared with packages/api/server/lib/opencode/config-v2.js via esbuild bundling.
 * Keep this module a thin re-export so the web server and the extension host
 * write byte-identical OpenCode 2.x config files.
 */
export * from '../../api/server/lib/opencode/config-v2.js';
