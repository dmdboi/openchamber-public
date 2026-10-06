/**
 * Shared with packages/api/server/lib/opencode/worktree-directory.js via esbuild
 * bundling. Keep this module a thin re-export so the web server and the
 * extension host resolve OpenCode's `worktree.directory` to the same folder.
 */
export * from '../../api/server/lib/opencode/worktree-directory.js';
