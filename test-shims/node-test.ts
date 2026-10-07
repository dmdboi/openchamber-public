// Maps the `node:test` surface used in this repository onto Vitest. Suites
// import `node:assert/strict` directly; only the runner API needs shimming.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe as vitestDescribe,
  expect,
  it,
  onTestFinished,
  test as vitestTest,
  vi,
} from 'vitest';

type TestBody = (context: TestContext) => void | Promise<void>;
type TestOptions = { skip?: boolean; todo?: boolean; only?: boolean };

type TestTimers = {
  enable: () => void;
  tick: (milliseconds: number) => void;
  reset: () => void;
  setTime: (milliseconds: number) => void;
};

type TestContext = {
  after: (hook: () => void | Promise<void>) => void;
  diagnostic: (message: string) => void;
  mock: { timers: TestTimers };
};

const context = (): TestContext => ({
  after: (hook) => onTestFinished(hook),
  diagnostic: () => undefined,
  mock: {
    timers: {
      enable: () => vi.useFakeTimers(),
      tick: (milliseconds) => vi.advanceTimersByTime(milliseconds),
      reset: () => vi.useRealTimers(),
      setTime: (milliseconds) => vi.setSystemTime(milliseconds),
    },
  },
});

const optionsOf = (optionsOrBody: TestBody | TestOptions | undefined): TestOptions | undefined =>
  optionsOrBody instanceof Object && !(optionsOrBody instanceof Function) ? optionsOrBody : undefined;

const bodyOf = (
  optionsOrBody: TestBody | TestOptions | undefined,
  maybeBody: TestBody | undefined,
): TestBody | undefined => (optionsOrBody instanceof Function ? optionsOrBody : maybeBody);

// node:test accepts `(name, body)` and `(name, options, body)`, where the options
// object carries `skip`/`todo`/`only` instead of Vitest's chained modifiers.
const registrar = (
  register: (name: string, body: () => void | Promise<void>) => void,
  skip: (name: string) => void,
  todo: (name: string) => void,
  only: (name: string, body: () => void | Promise<void>) => void,
) =>
  (name: string, optionsOrBody?: TestBody | TestOptions, maybeBody?: TestBody): void => {
    const options = optionsOf(optionsOrBody);
    if (options?.skip) {
      skip(name);
      return;
    }
    if (options?.todo) {
      todo(name);
      return;
    }
    const body = bodyOf(optionsOrBody, maybeBody);
    const run = body ? () => body(context()) : () => undefined;
    if (options?.only) {
      only(name, run);
      return;
    }
    register(name, run);
  };

const test = Object.assign(registrar(vitestTest, vitestTest.skip, vitestTest.todo, vitestTest.only), {
  skip: vitestTest.skip,
  todo: vitestTest.todo,
  only: vitestTest.only,
});

const describe = Object.assign(registrar(vitestDescribe, vitestDescribe.skip, vitestDescribe.todo, vitestDescribe.only), {
  skip: vitestDescribe.skip,
  todo: vitestDescribe.todo,
  only: vitestDescribe.only,
});

const before = beforeAll;
const after = afterAll;

const mock = {
  fn: vi.fn,
  restore: vi.restoreAllMocks,
  reset: vi.resetAllMocks,
  clearAllMocks: vi.clearAllMocks,
  timers: {
    enable: () => vi.useFakeTimers(),
    tick: (milliseconds: number) => vi.advanceTimersByTime(milliseconds),
    reset: () => vi.useRealTimers(),
    setTime: (milliseconds: number) => vi.setSystemTime(milliseconds),
  },
  // node:test's `mock.method` replaces a named method on the caller's host and
  // returns the replacement mock.
  method: <T extends object>(
    target: T,
    methodName: string,
    implementation?: (...args: never[]) => void,
  ) => {
    // SAFETY: node:test callers pass a host object and a method name they own;
    // vi.spyOn replaces that method and returns the spy.
    const spy = vi.spyOn(target as never, methodName as never);
    if (implementation) {
      // SAFETY: the caller-provided implementation has the host method's shape.
      spy.mockImplementation(implementation as never);
    }
    // SAFETY: the Vitest spy's mock context is mutable and this only adds the
    // node:test-compatible restore hook.
    (spy.mock as { restore?: () => void }).restore = () => spy.mockRestore();
    return spy;
  },
};

export { after, afterAll, afterEach, before, beforeAll, beforeEach, describe, expect, it, mock, test };
export default test;
