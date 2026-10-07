// Maps the `bun:test` surface used in this repository onto Vitest, so suites
// can move to the single Vitest runner without rewriting every test file.
//
// `mock.module` intentionally maps to `vi.doMock`, not `vi.mock`. Bun's
// `mock.module` is a runtime call whose factory may close over modules the test
// already imported, and callers follow it with `await import(...)`. `vi.mock` is
// hoisted and cannot see those bindings; `vi.doMock` keeps the call-time
// semantics the callers rely on.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
  vi,
} from 'vitest';

type MockFactory = (...args: never[]) => void;

// Bun ships `toStartWith`; Vitest/Chai does not. Registered here so tests using
// it keep their assertions instead of being rewritten.
expect.extend({
  toStartWith(received: string, expected: string) {
    const pass = received.startsWith(expected);
    return {
      pass,
      message: () =>
        pass
          ? `expected "${received}" not to start with "${expected}"`
          : `expected "${received}" to start with "${expected}"`,
    };
  },
});

const mock = Object.assign(
  (implementation?: MockFactory) => vi.fn(implementation),
  {
    // Bun's `mock.module` is a call-time module replacement. `vi.doMock` is the
    // closest Vitest equivalent (not hoisted), but it cannot replace a module a
    // test has already imported statically. Suites that mock a statically
    // imported dependency therefore cannot move off Bun; see test-shims/README.md.
    module: vi.doMock,
    restore: vi.restoreAllMocks,
    clearAllMocks: vi.clearAllMocks,
    resetAllMocks: vi.resetAllMocks,
  },
);

const spyOn = vi.spyOn;
const jest = vi;
const setSystemTime = vi.setSystemTime;
const setDefaultTimeout = (timeout: number) => vi.setConfig({ testTimeout: timeout });

export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
  setDefaultTimeout,
  setSystemTime,
  spyOn,
  test,
  vi,
};
