// Shared with packages/web/server/lib/projects/project-setup.js via esbuild
// bundling. Keep this module a thin re-export so a value written from VS Code
// reads back the same on every other surface.
//
// Kept free of `vscode` imports so it is unit-tested directly.
export * from '../../web/server/lib/projects/project-setup.js';

/** The extension host's name for the canonical personal-view parser. */
export { projectSetupViewOf as personalProjectSetupOf } from '../../web/server/lib/projects/project-setup.js';
