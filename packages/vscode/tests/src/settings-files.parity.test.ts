import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as fromVscode from '../../src/settings-files';
import * as fromWeb from '../../../api/server/lib/opencode/settings-files.js';

// Every runtime export the canonical module ships. The extension host must
// re-export the same bindings, not a copy, so the two runtimes cannot drift.
const SHARED_SETTINGS_EXPORTS = [
  'normalizeSettingsSurface',
  'settingsSurfaceOf',
  'isProfileSettingsKey',
  'isDeviceSettingsKey',
  'isPerSurfaceSettingsKey',
  'preferencesFilePathFor',
  'parsePreferencesDocument',
  'serializePreferencesDocument',
  'flattenPreferences',
  'buildPreferencesFields',
  'instancePartOf',
  'profilePartOf',
  'legacySettingsDocumentOf',
  'seedPreferencesFrom',
  'readMergedSettingsSync',
  'provideSettingsRegistryFields',
] as const satisfies readonly (keyof typeof fromWeb)[];

describe('settings-files parity (vscode ↔ web)', () => {
  test('re-exports every canonical export by reference', () => {
    for (const name of SHARED_SETTINGS_EXPORTS) {
      assert.equal(fromVscode[name], fromWeb[name], `${name} is the shared binding`);
    }
  });

  test('adds only the VS Code surface constant on top of the canonical exports', () => {
    assert.deepEqual(
      Object.keys(fromVscode).sort(),
      [...Object.keys(fromWeb), 'VSCODE_SETTINGS_SURFACE'].sort(),
    );
    assert.equal(fromVscode.VSCODE_SETTINGS_SURFACE, 'vscode');
  });

  test('splits and parses a merged document identically on both sides', () => {
    const document = { themeId: 'nord', opencodeBinary: '/bin/oc' };
    assert.deepEqual(
      fromVscode.buildPreferencesFields({}, document, 42),
      fromWeb.buildPreferencesFields({}, document, 42),
    );

    const raw = JSON.stringify({ version: 1, fields: { themeId: { value: 'nord', updatedAt: 7 } } });
    assert.deepEqual(fromVscode.parsePreferencesDocument(raw), fromWeb.parsePreferencesDocument(raw));

    const fields = fromVscode.seedPreferencesFrom(document, 42);
    assert.deepEqual(
      fromVscode.flattenPreferences(fields, 'vscode'),
      fromWeb.flattenPreferences(fields, 'vscode'),
    );
  });
});
