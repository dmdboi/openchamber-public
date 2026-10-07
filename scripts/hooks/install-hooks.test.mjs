import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HOOK_FILE, HOOKS_PATH, planInstall } from './install-hooks.mjs';

const INSTALLER = fileURLToPath(new URL('./install-hooks.mjs', import.meta.url));
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

// Keep the throwaway repositories from picking up the developer's global git
// configuration, so a machine-level core.hooksPath cannot change the outcome.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
};

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();
const runInstaller = (cwd, args = []) => execFileSync(process.execPath, [INSTALLER, ...args], {
  cwd,
  encoding: 'utf8',
  env: gitEnv,
});

function withRepo(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oc-hooks-install-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnv });
    const hooksDirectory = path.join(root, HOOKS_PATH);
    mkdirSync(hooksDirectory);
    const hookPath = path.join(hooksDirectory, HOOK_FILE);
    writeFileSync(hookPath, '#!/bin/sh\nexit 0\n');
    chmodSync(hookPath, 0o755);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('planInstall installs when unset, no-ops when already installed, refuses a different path', () => {
  assert.equal(planInstall('').action, 'install');
  assert.equal(planInstall(HOOKS_PATH).action, 'noop');
  assert.equal(planInstall('.husky').action, 'refuse');
  assert.equal(planInstall('.husky', true).action, 'install');
});

test('the installer sets core.hooksPath once and is idempotent', () => {
  withRepo((root) => {
    const first = runInstaller(root);
    assert.match(first, new RegExp(`Setting core\\.hooksPath to ${HOOKS_PATH}\\.`));
    assert.equal(git(root, ['config', '--local', '--get', 'core.hooksPath']), HOOKS_PATH);

    const second = runInstaller(root);
    assert.match(second, /already points at/);
    assert.equal(git(root, ['config', '--local', '--get', 'core.hooksPath']), HOOKS_PATH);
  });
});

test('the installer refuses to replace a different hooks path unless forced', () => {
  withRepo((root) => {
    git(root, ['config', '--local', 'core.hooksPath', '.husky']);

    assert.throws(
      () => runInstaller(root),
      (error) => error.status === 1,
    );
    assert.equal(git(root, ['config', '--local', '--get', 'core.hooksPath']), '.husky');

    runInstaller(root, ['--force']);
    assert.equal(git(root, ['config', '--local', '--get', 'core.hooksPath']), HOOKS_PATH);
  });
});

test('the installer fails outside a git working tree', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oc-hooks-norepo-'));
  try {
    assert.throws(
      () => runInstaller(root),
      (error) => error.status === 1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the hook stays opt-in and the committed wrapper is executable', () => {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts['hooks:install'], 'node scripts/hooks/install-hooks.mjs');
  assert.doesNotMatch(manifest.scripts.postinstall, /hooks:install/);

  const wrapper = path.join(REPO_ROOT, HOOKS_PATH, HOOK_FILE);
  assert.equal(existsSync(wrapper), true);
  if (process.platform !== 'win32') {
    assert.notEqual(statSync(wrapper).mode & 0o111, 0);
  }
});
