import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCheckPlan,
  classifyFile,
  createContentReader,
  isTestFile,
  isLintScoped,
  isWebVitestFile,
  moduleTypeFor,
  parseStagedPaths,
  planTestRuns,
  readStagedPaths,
  readUnstagedPaths,
  selectPartiallyStaged,
  selectTestFiles,
} from './pre-commit.mjs';

test('parseStagedPaths keeps paths with spaces and newlines', () => {
  const output = 'src/a.ts\0dir/with space/b.tsx\0weird\nname.mjs\0';
  assert.deepEqual(parseStagedPaths(output), ['src/a.ts', 'dir/with space/b.tsx', 'weird\nname.mjs']);
});

test('parseStagedPaths returns nothing for empty output', () => {
  assert.deepEqual(parseStagedPaths(''), []);
  assert.deepEqual(parseStagedPaths(undefined), []);
});

test('classifyFile routes each supported extension', () => {
  assert.equal(classifyFile('packages/ui/src/a.ts'), 'eslint');
  assert.equal(classifyFile('packages/web/src/a.tsx'), 'eslint');
  assert.equal(classifyFile('src/a.js'), 'node-check');
  assert.equal(classifyFile('src/a.mjs'), 'node-check');
  assert.equal(classifyFile('src/a.cjs'), 'node-check');
  assert.equal(classifyFile('package.json'), 'json');
  assert.equal(classifyFile('scripts/run.sh'), 'shell');
  assert.equal(classifyFile('scripts/run.bash'), 'shell');
  assert.equal(classifyFile('.github/workflows/ci.yml'), 'yaml');
  assert.equal(classifyFile('config/app.yaml'), 'yaml');
});

test('classifyFile lints TypeScript only inside a package lint scope', () => {
  assert.equal(classifyFile('packages/sdk/examples/panel/index.ts'), 'eslint');
  assert.equal(classifyFile('packages/vscode/webview/main.tsx'), 'eslint');
  assert.equal(classifyFile('packages/sdk/tests/src/manifest.test.ts'), 'eslint');
  assert.equal(classifyFile('packages/vscode/tests/src/bridge.test.ts'), 'eslint');
  assert.equal(classifyFile('packages/electron/main.ts'), null);
  assert.equal(classifyFile('tools/oxlint/rule.ts'), null);
  assert.equal(classifyFile('vite.config.ts'), null);
  assert.equal(isLintScoped('packages/ui/srcs/a.ts'), false);
});

test('classifyFile parses comment-tolerant JSON files as JSONC', () => {
  assert.equal(classifyFile('knip.json'), 'jsonc');
  assert.equal(classifyFile('packages/ui/tsconfig.json'), 'jsonc');
  assert.equal(classifyFile('packages/vscode/tsconfig.webview.json'), 'jsonc');
  assert.equal(classifyFile('.vscode/settings.json'), 'jsonc');
  assert.equal(classifyFile('config/app.jsonc'), 'jsonc');
  assert.equal(classifyFile('packages/ui/package.json'), 'json');
  assert.equal(classifyFile('docs/not-knip.json'), 'json');
});

test('classifyFile treats an extensionless file as shell only with a sh or bash shebang', () => {
  const firstLines = new Map([
    ['.githooks/pre-commit', '#!/bin/sh'],
    ['bin/tool', '#!/usr/bin/env bash'],
    ['bin/cli', '#!/usr/bin/env node'],
    ['LICENSE', 'MIT License'],
  ]);
  const readFirstLine = (filePath) => firstLines.get(filePath);
  assert.equal(classifyFile('.githooks/pre-commit', readFirstLine), 'shell');
  assert.equal(classifyFile('bin/tool', readFirstLine), 'shell');
  assert.equal(classifyFile('bin/cli', readFirstLine), null);
  assert.equal(classifyFile('LICENSE', readFirstLine), null);
});

test('classifyFile skips generated and vendored directories', () => {
  assert.equal(classifyFile('node_modules/pkg/a.ts'), null);
  assert.equal(classifyFile('packages/ui/dist/a.js'), null);
  assert.equal(classifyFile('packages/ui/build/a.tsx'), null);
  assert.equal(classifyFile('packages/mobile/android/a.json'), null);
});

test('classifyFile skips formats no check covers', () => {
  assert.equal(classifyFile('README.md'), null);
  assert.equal(classifyFile('assets/logo.png'), null);
  assert.equal(classifyFile('bun.lock'), null);
});

test('buildCheckPlan groups files by check and keeps them unchanged', () => {
  const plan = buildCheckPlan([
    'packages/ui/src/a.ts',
    'packages/ui/src/with space/b.ts',
    'src/c.js',
    'package.json',
    'knip.json',
    'scripts/run.sh',
    'deploy.yml',
    'README.md',
  ]);
  assert.deepEqual(plan.eslint, ['packages/ui/src/a.ts', 'packages/ui/src/with space/b.ts']);
  assert.deepEqual(plan['node-check'], ['src/c.js']);
  assert.deepEqual(plan.json, ['package.json']);
  assert.deepEqual(plan.jsonc, ['knip.json']);
  assert.deepEqual(plan.shell, ['scripts/run.sh']);
  assert.deepEqual(plan.yaml, ['deploy.yml']);
  assert.deepEqual(plan.skipped, ['README.md']);
});

test('selectPartiallyStaged returns only staged paths with unstaged edits', () => {
  const staged = ['a.ts', 'b.ts', 'c.ts'];
  const unstaged = ['b.ts', 'd.ts'];
  assert.deepEqual(selectPartiallyStaged(staged, unstaged), ['b.ts']);
});

test('selectTestFiles finds test and spec files in nested paths', () => {
  const files = ['src/a.test.ts', 'src/b.spec.tsx', 'src/c.ts', 'e2e/deep/x.test.mjs'];
  assert.deepEqual(selectTestFiles(files), ['src/a.test.ts', 'src/b.spec.tsx', 'e2e/deep/x.test.mjs']);
});

test('selectTestFiles includes the UI vitest files and skips ignored directories', () => {
  const files = [
    'packages/ui/src/components/views/Thing.vitest.tsx',
    'node_modules/pkg/dep.test.js',
    'packages/ui/dist/old.test.ts',
    'src/plain.ts',
  ];
  assert.deepEqual(selectTestFiles(files), ['packages/ui/src/components/views/Thing.vitest.tsx']);
  assert.equal(isTestFile('packages/ui/src/components/views/Thing.vitest.tsx'), true);
  assert.equal(isTestFile('packages/ui/vitest.config.ts'), false);
});

test('isWebVitestFile owns web tests and UI vitest files, including paths with spaces', () => {
  assert.equal(isWebVitestFile('packages/web/server/lib/relay/service.test.js'), true);
  assert.equal(isWebVitestFile('packages/web/dir with space/a.test.ts'), true);
  assert.equal(isWebVitestFile('packages/ui/src/components/views/Thing.vitest.tsx'), true);
  assert.equal(isWebVitestFile('packages/ui/src/lib/a.test.ts'), false);
  assert.equal(isWebVitestFile('packages/electron/tests/updater-check.test.mjs'), false);
  assert.equal(isWebVitestFile('scripts/bump-version.test.mjs'), false);
});

test('planTestRuns splits web Vitest files from the isolated runner and keeps paths intact', () => {
  const runs = planTestRuns([
    'packages/web/server/lib/relay/service.test.js',
    'packages/web/server/lib/relay/e2ee.test.js',
    'packages/ui/src/components/views/Thing.vitest.tsx',
    'packages/ui/src/lib/with space.test.ts',
    'packages/vscode/src/bridge.test.ts',
    'scripts/run-isolated-tests.test.mjs',
  ]);
  assert.deepEqual(runs.webVitest, [
    'packages/web/server/lib/relay/service.test.js',
    'packages/web/server/lib/relay/e2ee.test.js',
    'packages/ui/src/components/views/Thing.vitest.tsx',
  ]);
  assert.deepEqual(runs.isolated, [
    'packages/ui/src/lib/with space.test.ts',
    'packages/vscode/src/bridge.test.ts',
    'scripts/run-isolated-tests.test.mjs',
  ]);
});

test('readStagedPaths asks git for cached additions, copies, modifications and renames', () => {
  const calls = [];
  const paths = readStagedPaths((args) => {
    calls.push(args);
    return ['src/a.ts'];
  });
  assert.deepEqual(paths, ['src/a.ts']);
  assert.deepEqual(calls, [['diff', '--cached', '--name-only', '--diff-filter=ACMR']]);
});

test('readUnstagedPaths asks git for the working-tree diff without --cached', () => {
  const calls = [];
  readUnstagedPaths((args) => {
    calls.push(args);
    return [];
  });
  assert.deepEqual(calls, [['diff', '--name-only']]);
});

test('createContentReader reads partially staged files from the index and the rest from disk', () => {
  const readContent = createContentReader(
    ['partial.json'],
    (filePath) => `index:${filePath}`,
    (filePath) => `disk:${filePath}`,
  );
  assert.equal(readContent('partial.json'), 'index:partial.json');
  assert.equal(readContent('full.json'), 'disk:full.json');
});

test('moduleTypeFor uses the extension first, then the package type', () => {
  const packageType = (type) => () => type;
  assert.equal(moduleTypeFor('a.mjs', packageType('commonjs')), 'module');
  assert.equal(moduleTypeFor('a.cjs', packageType('module')), 'commonjs');
  assert.equal(moduleTypeFor('a.js', packageType('module')), 'module');
  assert.equal(moduleTypeFor('a.js', packageType(null)), null);
});
