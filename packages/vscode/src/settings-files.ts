// Shared with packages/web/server/lib/opencode/settings-files.js via esbuild
// bundling. Keep this module a thin re-export so the web server and the
// extension host cannot write different settings files.
//
// esbuild's CommonJS output has no `import.meta.url`, so inside the extension
// bundle the web module cannot load its checked-in registry snapshot by
// itself. Hand the bundled (identical) snapshot over before any accessor runs.
//
// Kept free of `vscode` imports so it is unit-tested directly.
import {
  provideSettingsRegistryFields,
  type SettingsSurface,
} from '../../web/server/lib/opencode/settings-files.js';
import { SETTINGS_REGISTRY_FIELDS } from './settings-registry-gate';

provideSettingsRegistryFields(SETTINGS_REGISTRY_FIELDS);

export * from '../../web/server/lib/opencode/settings-files.js';

/** The extension host is always the VS Code surface kind. */
export const VSCODE_SETTINGS_SURFACE: SettingsSurface = 'vscode';
