# Test shims

`bun-test.ts` and `node-test.ts` map the `bun:test` and `node:test` surfaces this
repository's tests import onto Vitest. Test files keep their original imports; the
per-package `vitest.config.ts` aliases the runner module to the shim, so a suite
moves runners without a file-by-file rewrite. `bun.ts` is a no-op stand-in for
Bun's bundler `plugin`/`gc`: under Vitest, Vite performs the asset transforms the
plugin emulated under `bun test`.

`node-test.ts` implements only the API the suites use, with faithful semantics:

- `test`/`describe` accept `(name, body)` and `(name, { skip, todo, only }, body)`.
- `t.after(hook)` registers a hook that runs after the test (Vitest
  `onTestFinished`).
- `t.mock.timers` and `mock.timers` map `enable`/`tick`/`reset`/`setTime` to
  Vitest fake timers.
- `mock.method(host, name, implementation)` replaces a method and returns a mock
  whose `mock.restore()` works, matching node:test.
- `before`/`after` map to `beforeAll`/`afterAll`.

`bun-test.ts` maps `mock` (including `mock.module`), `spyOn`, `jest`, and
`setSystemTime`, and registers the `toStartWith` matcher Bun provides.

`packages/electron/tests/node-test-adapter.test.mjs` and
`packages/electron/tests/bun-test-adapter.test.mjs` exercise that surface through
the aliases, so an adapter regression fails as a normal test.

## Runner status

Every suite runs on Vitest; `scripts/run-isolated-tests.mjs` and its test were
removed. Suites that need the Bun runtime (SDK, UI, VS Code, root scripts) run
the Vitest binary under `bun --bun`; API, CLI, web and Electron run under Node.

## Residual skipped cases

Four cases in one UI file remain skipped under Vitest because the test harness
replaces React and its JSX runtime after Vite has loaded those modules:

- `tests/src/components/chat/MarkdownRendererImpl.test.ts` (4): these tests use
  Bun's live `mock.module` behavior to replace `react` and its JSX runtime. The
  parser's 16 `parseFileReference` cases still run.

The other UI cases that initially needed fixture changes now run under Vitest.
