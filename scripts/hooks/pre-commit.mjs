#!/usr/bin/env node
// Staged-file checks for the opt-in pre-commit hook.
//
// The hook reads only the staged changeset, never a whole package, so it stays
// fast enough to run on every commit. TypeScript and TSX inside a package lint
// scope go through the repository ESLint config, the other text formats are
// syntax-checked against their staged content, and staged test files run with
// the runner their package uses. Bun and Node tests
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
  if (check === 'eslint' && !isLintScoped(filePath)) return null;
  return check;
}

/** Groups paths by check so each tool receives one list. */
export function buildCheckPlan(filePaths, readFirstLine) {
  const plan = { eslint: [], 'node-check': [], json: [], jsonc: [], shell: [], yaml: [], skipped: [] };
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
  return /^packages\/ui\/tests\/src\/.*\.vitest\.tsx$/.test(filePath);
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

// Files read from disk go to one ESLint run. A partially staged file goes
// through stdin with its index content, under its own path so the config still
// matches it.
function eslintFailures(files, partialPaths, readContent) {
  if (files.length === 0) return [];
  const binary = path.join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!existsSync(binary)) {
    return ['ESLint is not installed; run `bun install` before committing.'];
  }
  const partial = new Set(partialPaths);
  const runs = [];
  const fromDisk = files.filter((file) => !partial.has(file));
  if (fromDisk.length > 0) runs.push({ args: fromDisk });
  for (const file of files.filter((candidate) => partial.has(candidate))) {
    runs.push({ args: ['--stdin', '--stdin-filename', file], input: readContent(file) });
  }
  let reported = false;
  for (const { args, input } of runs) {
    const result = spawnSync(process.execPath, [binary, '--no-color', ...args], {
      cwd: REPO_ROOT,
      input,
      stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    });
    if (result.error) return [`ESLint failed to start: ${result.error.message}`];
    if (result.status !== 0) reported = true;
  }
  return reported ? ['ESLint reported problems in the staged TypeScript files above.'] : [];
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
    console.log(`pre-commit: running ${testFiles.length} staged test file(s) (${testRuns.webVitest.length} web, ${testRuns.isolated.length} isolated).`);
  }

  const failures = [
    ...eslintFailures(plan.eslint, partial, readContent),
    ...nodeCheckFailures(plan['node-check'], readContent),
    ...jsonFailures(plan.json, readContent),
    ...jsoncFailures(plan.jsonc, readContent),
    ...shellFailures(plan.shell, readContent),
    ...yamlFailures(plan.yaml, readContent),
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
