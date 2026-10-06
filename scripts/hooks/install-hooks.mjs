#!/usr/bin/env node
// Opts this clone into the committed pre-commit hook by pointing git at
// .githooks. Run `bun run hooks:install`. Enabling hooks is always an explicit
// step; nothing here is wired into the dependency install.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOKS_PATH = '.githooks';
export const HOOK_FILE = 'pre-commit';

/**
 * Decides what the installer would do. Kept separate from git so the policy is
 * testable: leave an existing hooks path alone unless the caller forces it.
 */
export function planInstall(currentHooksPath, force = false) {
  if (currentHooksPath === HOOKS_PATH) {
    return { action: 'noop', message: `core.hooksPath already points at ${HOOKS_PATH}.` };
  }
  if (currentHooksPath && !force) {
    return {
      action: 'refuse',
      message: `core.hooksPath is set to "${currentHooksPath}". Re-run with --force to replace it.`,
    };
  }
  return { action: 'install', message: `Setting core.hooksPath to ${HOOKS_PATH}.` };
}

function resolveRepoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function readCurrentHooksPath(root) {
  try {
    return execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

// A checkout that lost the executable bit (zip download, some Windows setups)
// would leave the hook silently inert, so restore it before pointing git at it.
function ensureExecutable(hookPath) {
  if (process.platform === 'win32') return;
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    // Best effort; git will report a non-executable hook when it runs it.
  }
}

function main() {
  const force = process.argv.slice(2).includes('--force');
  const root = resolveRepoRoot();
  if (!root) {
    console.error('hooks:install: not inside a git working tree.');
    process.exitCode = 1;
    return;
  }

  const hookPath = path.join(root, HOOKS_PATH, HOOK_FILE);
  if (!existsSync(hookPath)) {
    console.error(`hooks:install: expected ${HOOKS_PATH}/${HOOK_FILE} in ${root}.`);
    process.exitCode = 1;
    return;
  }

  const plan = planInstall(readCurrentHooksPath(root), force);
  if (plan.action === 'refuse') {
    console.error(`hooks:install: ${plan.message}`);
    process.exitCode = 1;
    return;
  }

  // Repair the executable bit even when the path is already set, so a checkout
  // that lost it does not leave the hook silently inert.
  ensureExecutable(hookPath);
  if (plan.action === 'noop') {
    console.log(`hooks:install: ${plan.message}`);
    return;
  }

  execFileSync('git', ['config', '--local', 'core.hooksPath', HOOKS_PATH], {
    cwd: root,
    stdio: 'inherit',
  });
  console.log(`hooks:install: ${plan.message}`);
  console.log('hooks:install: turn it off with `git config --unset core.hooksPath`.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
