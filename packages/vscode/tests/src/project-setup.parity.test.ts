import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as fromVscode from '../../src/project-setup';
import * as fromWeb from '../../../web/server/lib/projects/project-setup.js';
import type { SharedProjectConfig } from '../../src/project-setup';

// Every runtime export the canonical module ships. The extension host must
// re-export the same bindings, not a copy, so the two runtimes cannot drift.
const SHARED_PROJECT_SETUP_EXPORTS = [
  'SHARED_CONFIG_RELATIVE_PATH',
  'DEFAULT_PLANS_DIR',
  'EMPTY_SHARED_PROJECT_CONFIG',
  'ProjectSetupValidationError',
  'sanitizeSetupCommands',
  'sanitizeProjectActions',
  'sanitizeDraftStarters',
  'projectSetupViewOf',
  'projectSetupPatchToStored',
  'normalizePlansDir',
  'parseSharedProjectConfig',
  'sharedTrustHashOf',
  'mergeProjectSetup',
  'isSharedProjectConfigEmpty',
  'serializeSharedProjectConfig',
  'applySharedProjectSetupPatch',
  'isProjectSetupValidationError',
] as const satisfies readonly (keyof typeof fromWeb)[];

const shared: SharedProjectConfig = {
  setupWorktree: ['bun install'],
  setupWorktreeWait: true,
  projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev', icon: null }],
  draftStarters: [{ type: 'command', name: 'explore' }],
  plansDir: null,
};

describe('project-setup parity (vscode ↔ web)', () => {
  test('re-exports every canonical export by reference', () => {
    for (const name of SHARED_PROJECT_SETUP_EXPORTS) {
      assert.equal(fromVscode[name], fromWeb[name], `${name} is the shared binding`);
    }
  });

  test('keeps its VS Code name as an alias of the canonical parser', () => {
    assert.equal(fromVscode.personalProjectSetupOf, fromWeb.projectSetupViewOf);
    assert.deepEqual(
      Object.keys(fromVscode).sort(),
      [...Object.keys(fromWeb), 'personalProjectSetupOf'].sort(),
    );
  });

  test('parses, merges, and serializes identically on both sides', () => {
    assert.deepEqual(fromVscode.personalProjectSetupOf(null), fromWeb.projectSetupViewOf(null));
    assert.deepEqual(
      fromVscode.mergeProjectSetup(fromVscode.personalProjectSetupOf(null), { status: 'ok', config: shared }),
      fromWeb.mergeProjectSetup(fromWeb.projectSetupViewOf(null), { status: 'ok', config: shared }),
    );
    assert.deepEqual(
      fromVscode.serializeSharedProjectConfig(shared),
      fromWeb.serializeSharedProjectConfig(shared),
    );
  });

  test('throws the same shared validation type for a wrongly shaped patch', () => {
    assert.equal(fromVscode.ProjectSetupValidationError, fromWeb.ProjectSetupValidationError);
    assert.throws(() => fromVscode.projectSetupPatchToStored({ setupWorktree: 'x' }), fromVscode.ProjectSetupValidationError);
    assert.throws(() => fromWeb.projectSetupPatchToStored({ setupWorktree: 'x' }), fromWeb.ProjectSetupValidationError);
  });
});
