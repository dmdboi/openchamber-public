#!/usr/bin/env node
// Staged-file checks for the opt-in pre-commit hook.
//
// The hook reads only the staged changeset, never a whole package, so it stays
// fast enough to run on every commit. TypeScript and TSX inside a package lint
// scope go through the repository oxlint config, the other text formats are
// syntax-checked against their staged content, and staged test files run with
// their owning package's Vitest config (under Bun for the suites that need the
// Bun runtime). See README.md beside this file for the policy.
//
// Exit code 0 means every staged file passed, or nothing was staged. Exit code
// 1 means a check failed or its tooling is missing, which blocks the commit.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBunExecutable } from '../lib/bun-executable.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
// Every package with a `test` script, and the runtime its suite needs. Bun is
// required where the suite drives Bun-only APIs or resolves extensionless TS.
const VITEST_PACKAGES = [
  { dir: 'packages/api', runtime: 'node' },
  { dir: 'packages/cli', runtime: 'node' },
  { dir: 'packages/web', runtime: 'node' },
  { dir: 'packages/electron', runtime: 'node' },
  { dir: 'packages/sdk', runtime: 'bun' },
  { dir: 'packages/ui', runtime: 'bun' },
  { dir: 'packages/vscode', runtime: 'bun' },
];

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
  ['.ts', 'oxlint'],
  ['.tsx', 'oxlint'],
  ['.js', 'node-check'],
  ['.mjs', 'node-check'],
  ['.cjs', 'node-check'],
  ['.json', 'json'],
  ['.jsonc', 'jsonc'],
  ['.sh', 'shell'],
  ['.bash', 'shell'],
  ['.yml', 'yaml'],
  ['.yaml', 'yaml'],
]);

const TEST_FILE = /\.(?:test|spec|vitest)\./;

// JSON files whose tools accept comments and trailing commas. `JSON.parse`
// rejects valid files here, so they go through the TypeScript JSONC parser.
const JSONC_FILE = /(?:^|\/)(?:knip\.json|[jt]sconfig(?:\.[^/]*)?\.json|\.vscode\/[^/]+\.json)$/;

// The directories each package's `lint` script covers. The hook lints the same
// files so a commit is not blocked by files CI does not lint. Keep this in step
// with the `lint` scripts in packages/*/package.json; Electron lints nothing.
const LINT_SCOPES = [
  'packages/sdk/src/',
  'packages/sdk/examples/',
  'packages/sdk/tests/',
  'packages/ui/src/',
  'packages/ui/tests/',
  'packages/vscode/src/',
  'packages/vscode/webview/',
  'packages/vscode/tests/',
  'packages/web/src/',
  'packages/web/tests/',
];

const SHELL_SHEBANG = /^#!.*\b(?:ba)?sh\b/;

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

export function isLintScoped(filePath) {
  return LINT_SCOPES.some((scope) => filePath.startsWith(scope));
}

/**
 * The check a staged path needs, or `null` when nothing applies. A file without
 * an extension, such as `.githooks/pre-commit`, is a shell script when its
 * first line is a sh or bash shebang.
 */
export function classifyFile(filePath, readFirstLine = () => '') {
  if (isIgnoredPath(filePath)) return null;
  const extension = path.posix.extname(filePath).toLowerCase();
  if (extension === '') return SHELL_SHEBANG.test(readFirstLine(filePath)) ? 'shell' : null;
  const check = CHECK_BY_EXTENSION.get(extension) ?? null;
  if (check === 'json' && JSONC_FILE.test(filePath)) return 'jsonc';
  if (check === 'oxlint' && !isLintScoped(filePath)) return null;
  return check;
}

/** Groups paths by check so each tool receives one list. */
export function buildCheckPlan(filePaths, readFirstLine) {
  const plan = { oxlint: [], 'node-check': [], json: [], jsonc: [], shell: [], yaml: [], skipped: [] };
  for (const filePath of filePaths) {
    const check = classifyFile(filePath, readFirstLine);
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

/** Test files, including the UI `*.vitest.tsx` cases a Vitest config runs. */
export function isTestFile(filePath) {
  return TEST_FILE.test(filePath) && !isIgnoredPath(filePath);
}

export function selectTestFiles(filePaths) {
  return filePaths.filter((filePath) => isTestFile(filePath));
}

/**
 * The package whose Vitest config runs a test file. Root `scripts` tests use the
 * repository-level config; the UI `*.vitest.tsx` cases belong to the UI config.
 */
export function vitestPackageFor(filePath) {
  const owner = VITEST_PACKAGES.find((entry) => filePath.startsWith(`${entry.dir}/`));
  if (owner) return owner.dir;
  if (filePath.startsWith('scripts/')) return '';
  return null;
}

/** Groups staged test files by owning Vitest package. */
export function planTestRuns(filePaths) {
  const vitest = {};
  const unknown = [];
  for (const filePath of filePaths) {
    const packageDir = vitestPackageFor(filePath);
    if (packageDir === null) unknown.push(filePath);
    else (vitest[packageDir] ??= []).push(filePath);
  }
  return { vitest, unknown };
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

/**
 * Reads the content a check sees. A partially staged file is read from the
 * index, so the check matches what the commit contains; every other staged file
 * is identical on disk and in the index, so it is read from disk.
 */
export function createContentReader(partialPaths, readStagedBlob = readIndexBlob, readDisk = readWorkingTreeFile) {
  const partial = new Set(partialPaths);
  return (filePath) => (partial.has(filePath) ? readStagedBlob(filePath) : readDisk(filePath));
}

function readIndexBlob(filePath) {
  return execFileSync('git', ['show', `:${filePath}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readWorkingTreeFile(filePath) {
  return readFileSync(path.resolve(REPO_ROOT, filePath), 'utf8');
}

/**
 * The `--input-type` Node needs to parse a file read from stdin, where Node
 * cannot see the file's extension or package. `null` means the package sets no
 * type, so Node would detect the module syntax from the source.
 */
export function moduleTypeFor(filePath, readPackageType = readNearestPackageType) {
  const extension = path.posix.extname(filePath).toLowerCase();
  if (extension === '.mjs') return 'module';
  if (extension === '.cjs') return 'commonjs';
  return readPackageType(filePath);
}

function readNearestPackageType(filePath) {
  let directory = path.dirname(path.resolve(REPO_ROOT, filePath));
  while (true) {
    const manifest = path.join(directory, 'package.json');
    if (existsSync(manifest)) {
      const { type } = JSON.parse(readFileSync(manifest, 'utf8'));
      return type === 'module' || type === 'commonjs' ? type : null;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
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

// Files read from disk go to one oxlint run. oxlint has no stdin mode, so a
// partially staged file is checked from its working-tree copy; stage everything
// to lint exactly what the commit contains.
function oxlintFailures(files) {
  if (files.length === 0) return [];
  const binary = path.join(REPO_ROOT, 'node_modules', 'oxlint', 'bin', 'oxlint');
  if (!existsSync(binary)) {
    return ['oxlint is not installed; run `bun install` before committing.'];
  }
  const result = spawnSync(
    process.execPath,
    [binary, '--config', path.join(REPO_ROOT, 'oxlint.lint.config.ts'), ...files],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
  if (result.error) return [`oxlint failed to start: ${result.error.message}`];
  return result.status === 0 ? [] : ['oxlint reported problems in the staged TypeScript files above.'];
}

function checkJavaScript(source, inputType) {
  return spawnSync(process.execPath, ['--check', `--input-type=${inputType}`], {
    input: source,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// Node checks stdin without knowing the file's package, so the module type is
// passed explicitly. A package without a type lets Node detect ES module
// syntax, so the file passes when it parses as either kind.
function nodeCheckFailures(files, readContent) {
  const failures = [];
  for (const file of files) {
    const source = readContent(file);
    const moduleType = moduleTypeFor(file);
    const attempts = moduleType ? [moduleType] : ['commonjs', 'module'];
    let result;
    for (const inputType of attempts) {
      result = checkJavaScript(source, inputType);
      if (result.error || result.status === 0) break;
    }
    if (result.error) {
      failures.push(`${file}: ${result.error.message}`);
    } else if (result.status !== 0) {
      process.stderr.write(`${file}:\n${result.stderr}`);
      failures.push(`${file}: JavaScript syntax error above.`);
    }
  }
  return failures;
}

function jsonFailures(files, readContent) {
  const failures = [];
  for (const file of files) {
    try {
      JSON.parse(readContent(file));
    } catch {
      failures.push(`${file}: not valid JSON.`);
    }
  }
  return failures;
}

function jsoncFailures(files, readContent) {
  if (files.length === 0) return [];
  let typescript;
  try {
    typescript = require('typescript');
  } catch {
    return ['The `typescript` package is not installed; run `bun install` before committing.'];
  }
  const failures = [];
  for (const file of files) {
    const { error } = typescript.parseConfigFileTextToJson(file, readContent(file));
    if (error) failures.push(`${file}: not valid JSON with comments.`);
  }
  return failures;
}

function shellFailures(files, readContent) {
  if (files.length === 0) return [];
  if (process.platform === 'win32') {
    console.error('pre-commit: skipping shell syntax checks on Windows.');
    return [];
  }
  const failures = [];
  for (const file of files) {
    const source = readContent(file);
    const firstLine = source.split('\n', 1)[0];
    const interpreter = firstLine.includes('bash') ? 'bash' : 'sh';
    const result = spawnSync(interpreter, ['-n'], { input: source, stdio: ['pipe', 'inherit', 'inherit'] });
    if (result.error) failures.push(`${file}: could not run ${interpreter} -n (${result.error.message}).`);
    else if (result.status !== 0) failures.push(`${file}: shell syntax error above.`);
  }
  return failures;
}

function yamlFailures(files, readContent) {
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
      yaml.parse(readContent(file));
    } catch {
      failures.push(`${file}: not valid YAML.`);
    }
  }
  return failures;
}

// Each package runs its staged files once, from its own directory, so its config
// and its `bun:test` shim apply. Suites that need the Bun runtime run the Vitest
// binary under `bun --bun`.
function vitestFailures(filesByPackage) {
  const failures = [];
  for (const [packageDir, files] of Object.entries(filesByPackage)) {
    const packageRoot = packageDir ? path.join(REPO_ROOT, packageDir) : REPO_ROOT;
    const binary = path.join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs');
    if (!existsSync(binary)) {
      failures.push(`${packageDir || 'root'}: Vitest is not installed; run \`bun install\` before committing.`);
      continue;
    }
    const args = ['run', ...files.map((file) => path.resolve(REPO_ROOT, file))];
    const result = runtimeForPackage(packageDir) === 'bun'
      ? spawnSync(resolveBunExecutable(), ['--bun', binary, ...args], { cwd: packageRoot, stdio: 'inherit' })
      : spawnSync(process.execPath, [binary, ...args], { cwd: packageRoot, stdio: 'inherit' });
    if (result.error) failures.push(`${packageDir || 'root'}: Vitest failed to start: ${result.error.message}`);
    else if (result.status !== 0) failures.push(`${packageDir || 'root'}: staged Vitest tests failed above.`);
  }
  return failures;
}

const runtimeForPackage = (packageDir) =>
  VITEST_PACKAGES.find((entry) => entry.dir === packageDir)?.runtime ?? 'bun';

function main() {
  const staged = readStagedPaths();
  if (staged.length === 0) {
    console.log('pre-commit: no staged files to check.');
    return;
  }

  const present = selectPresentFiles(staged);
  const partial = selectPartiallyStaged(present, readUnstagedPaths());
  const readContent = createContentReader(partial);
  const plan = buildCheckPlan(present, (file) => readContent(file).split('\n', 1)[0]);
  const testFiles = selectTestFiles(present);
  const testRuns = planTestRuns(testFiles);

  console.log(`pre-commit: checking ${present.length} staged file(s).`);
  const partialTests = selectPartiallyStaged(testFiles, partial);
  if (partialTests.length > 0) {
    console.error('pre-commit: these test files also have unstaged changes; tests run against the working tree:');
    for (const file of partialTests) console.error(`  ${file}`);
    console.error('pre-commit: stage everything, or stash the unstaged part, to test exactly what you commit.');
  }
  if (testFiles.length > 0) {
    const vitestCount = Object.values(testRuns.vitest).reduce((count, files) => count + files.length, 0);
    console.log(`pre-commit: running ${testFiles.length} staged test file(s) (${vitestCount} Vitest, ${testRuns.unknown.length} unrecognized).`);
  }

  const failures = [
    ...oxlintFailures(plan.oxlint),
    ...nodeCheckFailures(plan['node-check'], readContent),
    ...jsonFailures(plan.json, readContent),
    ...jsoncFailures(plan.jsonc, readContent),
    ...shellFailures(plan.shell, readContent),
    ...yamlFailures(plan.yaml, readContent),
    ...vitestFailures(testRuns.vitest),
    ...testRuns.unknown.map((file) => `${file}: no Vitest package owns this test file.`),
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
