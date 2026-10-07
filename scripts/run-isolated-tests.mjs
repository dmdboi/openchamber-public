#!/usr/bin/env node
// Runs every test file under the given roots, each in its own process.
//
// Two properties of this repository make that the working arrangement rather
// than a preference:
//
// - The shared UI and extension suites keep module-level singletons (runtime
//   endpoint, relay tunnel, stores, registries). Executed in one process they
//   leak state into each other and fail by load order, which is why the relay
//   guidance already says to run those files one at a time.
// - The same directories mix `bun:test` and `node:test` files, so no single
//   runner command covers them. The framework is read from the file's imports
//   instead of being listed here, so adding a test never requires editing a
//   list that then rots.
//
// Usage:
//   node scripts/run-isolated-tests.mjs <root> [...roots]
//   node scripts/run-isolated-tests.mjs --files <file> [...files]
//
// `--files` runs exactly the listed files, which is how the pre-commit hook
// tests only the staged test files. Both modes give each file its own process
// and run it from the nearest package.json directory, so Bun and Node read the
// config a package script would. That lets one directory-mode invocation span
// several packages (the root `test` script passes every isolated suite root at
// once) without the working directory drifting to the caller's.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { resolveBunExecutable } from './lib/bun-executable.mjs';

const TEST_FILE = /\.(test|spec)\.(js|cjs|mjs|jsx|ts|tsx)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-bundle', 'build', 'out', '.git', 'ios', 'android']);
const MAX_PARALLEL = 4;
const bunExecutable = resolveBunExecutable();

const collect = (root, found = []) => {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(full, found);
      continue;
    }
    if (TEST_FILE.test(entry.name)) found.push(full);
  }
  return found;
};

/** `null` when the file names no known runner, so it is reported instead of skipped silently. */
const resolveCommand = (file) => {
  const source = readFileSync(file, 'utf8');
  const isTypeScript = /\.tsx?$/.test(file);
  // TypeScript goes to Bun even when the file imports `node:test`, which Bun
  // implements. Node's ESM loader cannot resolve the extensionless local
  // specifiers these files use (`./sseProxy`), so it never ran them at all.
  if (isTypeScript || /(?:from\s+|require\(\s*)['"]bun:test['"]/.test(source)) {
    return { label: 'bun', command: bunExecutable, args: ['test', file] };
  }
  if (/(?:from\s+|require\(\s*)['"]node:test['"]/.test(source)) {
    return { label: 'node', command: 'node', args: ['--test', file] };
  }
  return null;
};

// The package a test belongs to, found from its nearest package.json. Every
// file runs there so `bun test` and `node --test` resolve the same directory a
// package script would.
const packageRootFor = (file) => {
  let directory = path.dirname(file);
  while (true) {
    if (existsSync(path.join(directory, 'package.json'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return path.dirname(file);
    directory = parent;
  }
};

// Only the tail of a file's output is kept for its failure report. A test that
// logs in a loop otherwise grows the buffer past V8's string limit and takes
// the whole run down with a RangeError that names no file.
const OUTPUT_TAIL_BYTES = 1024 * 1024;

// A hung file is killed so it cannot block the run. The whole CI test step
// takes about two minutes, so this leaves room for slower machines.
const FILE_TIMEOUT_MS = 5 * 60 * 1000;

const run = ({ command, args, cwd }) => new Promise((resolve) => {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // A process the test started can hold the pipes open after the kill, so
    // `close` may never come. Stop reading and settle on `exit`. The file may
    // also have exited on its own long ago with only that process left; then
    // `exit` is over and the settle happens right away.
    const settle = () => {
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code: 1, output: report(), dropped, timedOut });
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      settle();
      return;
    }
    child.once('exit', settle);
    child.kill('SIGKILL');
  }, FILE_TIMEOUT_MS);
  let output = '';
  let dropped = 0;
  const append = (chunk) => {
    output += chunk;
    if (output.length > 2 * OUTPUT_TAIL_BYTES) {
      dropped += output.length - OUTPUT_TAIL_BYTES;
      output = output.slice(-OUTPUT_TAIL_BYTES);
    }
  };
  const report = () => (dropped > 0 ? `[${dropped} earlier characters of output dropped]\n${output}` : output);
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (error) => {
    clearTimeout(timer);
    resolve({ code: 1, output: `${report()}${error.message}`, dropped, timedOut });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ code: code ?? 1, output: report(), dropped, timedOut });
  });
});

const args = process.argv.slice(2);
const explicitMode = args[0] === '--files';
let files = [];

if (!explicitMode && args.includes('--files')) {
  console.error('run-isolated-tests: --files must be the first argument');
  process.exit(1);
}

if (explicitMode) {
  const requested = args.slice(1);
  if (requested.length === 0) {
    console.error('run-isolated-tests: --files expects at least one test file');
    process.exit(1);
  }
  for (const requestedFile of requested) {
    const resolvedFile = path.resolve(requestedFile);
    if (!existsSync(resolvedFile) || !statSync(resolvedFile).isFile()) {
      console.error(`run-isolated-tests: not a file: ${requestedFile}`);
      process.exit(1);
    }
    files.push(resolvedFile);
  }
} else {
  if (args.length === 0) {
    console.error('Usage: node scripts/run-isolated-tests.mjs <root> [...roots]');
    console.error('       node scripts/run-isolated-tests.mjs --files <file> [...files]');
    process.exit(1);
  }
  for (const root of args) {
    const resolved = path.resolve(root);
    if (!statSync(resolved).isDirectory()) {
      console.error(`run-isolated-tests: not a directory: ${root}`);
      process.exit(1);
    }
    files.push(...collect(resolved));
  }
}
files.sort();

const failures = [];
const unknown = [];
let passed = 0;
let next = 0;

const worker = async () => {
  while (next < files.length) {
    const file = files[next++];
    const relative = path.relative(process.cwd(), file);
    const resolved = resolveCommand(file);
    if (!resolved) {
      unknown.push(relative);
      continue;
    }
    const { code, output, dropped, timedOut } = await run({
      ...resolved,
      cwd: packageRootFor(file),
    });
    if (dropped > 0) console.error(`NOISY (${resolved.label}) ${relative}: ${dropped} characters of output dropped`);
    if (timedOut) {
      failures.push({ relative, label: resolved.label, output: `${output}\n[killed after ${FILE_TIMEOUT_MS / 1000}s]` });
      console.error(`TIMEOUT (${resolved.label}) ${relative}`);
    } else if (code === 0) {
      passed += 1;
    } else {
      failures.push({ relative, label: resolved.label, output });
      console.error(`FAIL (${resolved.label}) ${relative}`);
    }
  }
};

await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, files.length) }, worker));

for (const failure of failures) {
  console.error(`\n===== ${failure.relative} (${failure.label}) =====\n${failure.output}`);
}

for (const file of unknown) {
  console.error(`UNKNOWN RUNNER ${file}: imports neither bun:test nor node:test`);
}

console.log(`\n${passed}/${files.length} test files passed${failures.length ? `, ${failures.length} failed` : ''}${unknown.length ? `, ${unknown.length} with no known runner` : ''}`);

process.exit(failures.length > 0 || unknown.length > 0 ? 1 : 0);
