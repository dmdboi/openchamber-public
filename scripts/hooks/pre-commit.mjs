#!/usr/bin/env node
// Staged-file checks for the opt-in pre-commit hook.
//
// The hook reads only the staged changeset, never a whole package, so it stays
// fast enough to run on every commit. TypeScript and TSX go through the
// repository ESLint config, the other text formats are syntax-checked, and
// staged test files run with the runner their package uses. Bun and Node tests
// go through scripts/run-isolated-tests.mjs one file per process; web tests go
// through the web package's Vitest config. See README.md beside this file for
// the policy.
//
// Exit code 0 means every staged file passed, or nothing was staged. Exit code
// 1 means a check failed or its tooling is missing, which blocks the commit.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WEB_ROOT = path.join(REPO_ROOT, 'packages', 'web');
const VITEST_BIN = path.join(WEB_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const ISOLATED_RUNNER = path.join(REPO_ROOT, 'scripts', 'run-isolated-tests.mjs');

// Tracked files can still slip under these directories when they are force
// added, and generated or vendored output is not worth checking on commit.
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'dist-bundle',
  'build',
  'out',
  '.git',
  'ios',
  'android',
]);

const CHECK_BY_EXTENSION = new Map([
  ['.ts', 'eslint'],
  ['.tsx', 'eslint'],
  ['.js', 'node-check'],
  ['.mjs', 'node-check'],
  ['.cjs', 'node-check'],
  ['.json', 'json'],
  ['.sh', 'shell'],
  ['.bash', 'shell'],
  ['.yml', 'yaml'],
  ['.yaml', 'yaml'],
]);

const TEST_FILE = /\.(?:test|spec|vitest)\./;

/**
 * Splits `git ... -z` output into paths. NUL delimiting is what makes a path
 * with spaces, quotes or newlines survive, so nothing here trims or splits on
 * whitespace.
 */
export function parseStagedPaths(nulSeparated) {
  if (!nulSeparated) return [];
  return nulSeparated.split('\0').filter((entry) => entry.length > 0);
}

/** Paths under a generated or vendored directory that checks skip. */
export function isIgnoredPath(filePath) {
  return filePath.split('/').some((segment) => IGNORED_SEGMENTS.has(segment));
}

/** The check a staged path needs, or `null` when nothing applies. */
export function classifyFile(filePath) {
  if (isIgnoredPath(filePath)) return null;
  return CHECK_BY_EXTENSION.get(path.posix.extname(filePath).toLowerCase()) ?? null;
}

/** Groups paths by check so each tool receives one list. */
export function buildCheckPlan(filePaths) {
  const plan = { eslint: [], 'node-check': [], json: [], shell: [], yaml: [], skipped: [] };
  for (const filePath of filePaths) {
    const check = classifyFile(filePath);
    if (check) plan[check].push(filePath);
    else plan.skipped.push(filePath);
  }
  return plan;
}

/** Paths that are both staged and edited in the working tree. */
export function selectPartiallyStaged(stagedPaths, unstagedPaths) {
  const unstaged = new Set(unstagedPaths);
  return stagedPaths.filter((filePath) => unstaged.has(filePath));
}

/** Test files, including the UI `*.vitest.tsx` cases the web config runs. */
export function isTestFile(filePath) {
  return TEST_FILE.test(filePath) && !isIgnoredPath(filePath);
}

export function selectTestFiles(filePaths) {
  return filePaths.filter((filePath) => isTestFile(filePath));
}

// The web package's `test` script is `vitest run`, and its Vitest config maps
// `bun:test` to a shim, so every web test belongs to Vitest. The UI
// `*.vitest.tsx` files are in the same config's include list.
export function isWebVitestFile(filePath) {
  if (filePath.startsWith('packages/web/')) return true;
  return /^packages\/ui\/src\/.*\.vitest\.tsx$/.test(filePath);
}

/** Splits staged test files between the web Vitest run and the isolated runner. */
export function planTestRuns(filePaths) {
  const webVitest = [];
  const isolated = [];
  for (const filePath of filePaths) {
    if (isWebVitestFile(filePath)) webVitest.push(filePath);
    else isolated.push(filePath);
  }
  return { webVitest, isolated };
}

const runGitPaths = (args) => parseStagedPaths(
  execFileSync('git', [...args, '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
);

// `--diff-filter=ACMR` drops deletions and unmerged entries, so a deleted file
// never reaches a checker. Renames and copies arrive as their new path.
export function readStagedPaths(runGit = runGitPaths) {
  return runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
}

export function readUnstagedPaths(runGit = runGitPaths) {
  return runGit(['diff', '--name-only']);
}

function selectPresentFiles(filePaths) {
  const present = [];
  for (const filePath of filePaths) {
    const absolute = path.resolve(REPO_ROOT, filePath);
    if (existsSync(absolute) && statSync(absolute).isFile()) present.push(filePath);
    else console.error(`pre-commit: skipping ${filePath}: not present in the working tree.`);
  }
  return present;
}

function eslintFailures(files) {
  if (files.length === 0) return [];
  const binary = path.join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!existsSync(binary)) {
    return ['ESLint is not installed; run `bun install` before committing.'];
  }
  const result = spawnSync(process.execPath, [binary, '--no-color', ...files], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.error) return [`ESLint failed to start: ${result.error.message}`];
  return result.status === 0 ? [] : ['ESLint reported problems in the staged TypeScript files above.'];
}

function nodeCheckFailures(files) {
  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: REPO_ROOT, stdio: 'inherit' });
    if (result.error) failures.push(`${file}: ${result.error.message}`);
    else if (result.status !== 0) failures.push(`${file}: JavaScript syntax error above.`);
  }
  return failures;
}

function jsonFailures(files) {
  const failures = [];
  for (const file of files) {
    try {
      JSON.parse(readFileSync(path.resolve(REPO_ROOT, file), 'utf8'));
    } catch {
      failures.push(`${file}: not valid JSON.`);
    }
  }
  return failures;
}

function shellFailures(files) {
  if (files.length === 0) return [];
  if (process.platform === 'win32') {
    console.error('pre-commit: skipping shell syntax checks on Windows.');
    return [];
  }
  const failures = [];
  for (const file of files) {
    const absolute = path.resolve(REPO_ROOT, file);
    const firstLine = readFileSync(absolute, 'utf8').split('\n', 1)[0];
    const interpreter = firstLine.includes('bash') ? 'bash' : 'sh';
    const result = spawnSync(interpreter, ['-n', absolute], { stdio: 'inherit' });
    if (result.error) failures.push(`${file}: could not run ${interpreter} -n (${result.error.message}).`);
    else if (result.status !== 0) failures.push(`${file}: shell syntax error above.`);
  }
  return failures;
}

function yamlFailures(files) {
  if (files.length === 0) return [];
  let yaml;
  try {
    yaml = require('yaml');
  } catch {
    return ['The `yaml` package is not installed; run `bun install` before committing.'];
  }
  const failures = [];
  for (const file of files) {
    try {
      yaml.parse(readFileSync(path.resolve(REPO_ROOT, file), 'utf8'));
    } catch {
      failures.push(`${file}: not valid YAML.`);
    }
  }
  return failures;
}

// Bun and Node tests run through the isolated runner one file per process. It
// resolves the framework from each file and uses the package-relative cwd.
function isolatedTestFailures(files) {
  if (files.length === 0) return [];
  const result = spawnSync(
    process.execPath,
    [ISOLATED_RUNNER, '--files', ...files.map((file) => path.resolve(REPO_ROOT, file))],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
  if (result.error) return [`isolated test runner failed to start: ${result.error.message}`];
  return result.status === 0 ? [] : ['staged Bun and Node tests failed above.'];
}

// Every web test file, `bun:test` ones included, runs through the web package's
// Vitest config. The config maps `bun:test` to its shim, so the isolated
// runner would run them without that.
function webVitestFailures(files) {
  if (files.length === 0) return [];
  if (!existsSync(VITEST_BIN)) return ['Vitest is not installed; run `bun install` before committing.'];
  const result = spawnSync(
    process.execPath,
    [VITEST_BIN, 'run', ...files.map((file) => path.resolve(REPO_ROOT, file))],
    { cwd: WEB_ROOT, stdio: 'inherit' },
  );
  if (result.error) return [`Vitest failed to start: ${result.error.message}`];
  return result.status === 0 ? [] : ['staged web tests failed above.'];
}

function main() {
  const staged = readStagedPaths();
  if (staged.length === 0) {
    console.log('pre-commit: no staged files to check.');
    return;
  }

  const present = selectPresentFiles(staged);
  const plan = buildCheckPlan(present);
  const partial = selectPartiallyStaged(staged, readUnstagedPaths());
  const testFiles = selectTestFiles(present);
  const testRuns = planTestRuns(testFiles);

  console.log(`pre-commit: checking ${present.length} staged file(s).`);
  if (partial.length > 0) {
    console.error('pre-commit: these files also have unstaged changes, so the working-tree copy is used, linted and tested:');
    for (const file of partial) console.error(`  ${file}`);
    console.error('pre-commit: stage everything, or stash the unstaged part, to check exactly what you commit.');
  }
  if (testFiles.length > 0) {
    console.log(`pre-commit: running ${testFiles.length} staged test file(s) (${testRuns.webVitest.length} web, ${testRuns.isolated.length} isolated).`);
  }

  const failures = [
    ...eslintFailures(plan.eslint),
    ...nodeCheckFailures(plan['node-check']),
    ...jsonFailures(plan.json),
    ...shellFailures(plan.shell),
    ...yamlFailures(plan.yaml),
    ...isolatedTestFailures(testRuns.isolated),
    ...webVitestFailures(testRuns.webVitest),
  ];

  if (failures.length > 0) {
    console.error('\npre-commit: staged changes failed the following checks:');
    for (const failure of failures) console.error(`  ${failure}`);
    console.error('pre-commit: fix the problems above, then commit again. `git commit --no-verify` bypasses this.');
    process.exitCode = 1;
    return;
  }
  console.log('pre-commit: all staged checks passed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
