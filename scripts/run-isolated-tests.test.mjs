import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('./run-isolated-tests.mjs', import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(RUNNER), '..');

const PASSING = [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  '',
  "test('passes', () => {",
  '  assert.equal(1, 1);',
  '});',
  '',
].join('\n');

const CWD_FROM_PACKAGE = [
  "import assert from 'node:assert/strict';",
  "import { fileURLToPath } from 'node:url';",
  "import path from 'node:path';",
  "import test from 'node:test';",
  '',
  "test('cwd is the package root', () => {",
  "  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
  '  assert.equal(process.cwd(), packageRoot);',
  '});',
  '',
].join('\n');

const runRunner = (args) => {
  // The outer `node --test` sets NODE_TEST_CONTEXT, which changes how a nested
  // `node --test` behaves, so the child runner gets a clean copy.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    const stdout = execFileSync(process.execPath, [RUNNER, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    return { status: 0, output: stdout };
  } catch (error) {
    return { status: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

const writeFixture = (root, relative, contents) => {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
};

function withPackage(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'isolated-runner-'));
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'isolated-runner-fixture', private: true }));
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('--files runs the listed file from its package root', () => {
  withPackage((root) => {
    writeFixture(root, 'tests/cwd.test.mjs', CWD_FROM_PACKAGE);
    const result = runRunner(['--files', path.join(root, 'tests/cwd.test.mjs')]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /1\/1 test files passed/);
  });
});

test('--files reports a failing file with a non-zero exit', () => {
  withPackage((root) => {
    writeFixture(root, 'tests/fail.test.mjs', [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      '',
      "test('fails', () => {",
      '  assert.equal(1, 2);',
      '});',
      '',
    ].join('\n'));
    const result = runRunner(['--files', path.join(root, 'tests/fail.test.mjs')]);
    assert.equal(result.status, 1);
    assert.match(result.output, /0\/1 test files passed, 1 failed/);
  });
});

test('--files runs several files in one invocation', () => {
  withPackage((root) => {
    writeFixture(root, 'tests/one.test.mjs', PASSING);
    writeFixture(root, 'tests/two.test.mjs', PASSING);
    const result = runRunner([
      '--files',
      path.join(root, 'tests/one.test.mjs'),
      path.join(root, 'tests/two.test.mjs'),
    ]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /2\/2 test files passed/);
  });
});

test('--files rejects a directory', () => {
  withPackage((root) => {
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    const result = runRunner(['--files', path.join(root, 'tests')]);
    assert.equal(result.status, 1);
    assert.match(result.output, /not a file/);
  });
});

test('--files reports a file with no known runner', () => {
  withPackage((root) => {
    writeFixture(root, 'tests/plain.test.mjs', 'export const value = 1;\n');
    const result = runRunner(['--files', path.join(root, 'tests/plain.test.mjs')]);
    assert.equal(result.status, 1);
    assert.match(result.output, /UNKNOWN RUNNER/);
  });
});

test('--files without a file is a usage error', () => {
  const result = runRunner(['--files']);
  assert.equal(result.status, 1);
  assert.match(result.output, /--files expects at least one test file/);
});

test('--files after another argument is a usage error', () => {
  withPackage((root) => {
    writeFixture(root, 'tests/a.test.mjs', PASSING);
    const result = runRunner([root, '--files', path.join(root, 'tests/a.test.mjs')]);
    assert.equal(result.status, 1);
    assert.match(result.output, /--files must be the first argument/);
  });
});

test('directory mode still collects test files', () => {
  withPackage((root) => {
    writeFixture(root, 'plain/a.test.mjs', PASSING);
    const result = runRunner([path.join(root, 'plain')]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /1\/1 test files passed/);
  });
});

test('directory mode with no roots is a usage error', () => {
  const result = runRunner([]);
  assert.equal(result.status, 1);
  assert.match(result.output, /Usage: node scripts\/run-isolated-tests\.mjs/);
});
