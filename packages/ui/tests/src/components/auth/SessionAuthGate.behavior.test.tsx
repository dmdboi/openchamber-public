import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { AuthSessionState } from '@/lib/runtime-auth-expiry';

type TestNode = ElementNode | TestNode[] | string | number | boolean | null | undefined;
type Component<Props extends object = Record<string, never>> = (props: Props) => TestNode;
type ElementProps = {
  children?: TestNode;
  onChange?: (event: { target: { value: string } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => void | Promise<void>;
};
type ElementNode = { type: string | symbol; props: ElementProps };
type GateProps = { children?: TestNode };
type DesktopInvokeResult = { token?: string; status?: number };

type HookRecord = {
  values: unknown[];
  deps: Array<unknown[] | undefined>;
};

type HookEffect = () => void | (() => void);

const hookRecords = new Map<unknown, HookRecord>();
let currentRecord: HookRecord | null = null;
let hookIndex = 0;
let pendingEffects: Array<() => void> = [];
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

const resetHarness = () => {
  hookRecords.clear();
  currentRecord = null;
  hookIndex = 0;
  pendingEffects = [];
  runtimeApiBaseUrl = '';
  runtimeKey = 'local';
  runtimeEndpointChangedListener = null;
  desktopInvoke = async () => null;
  desktopHostsGetCalls = 0;
  desktopHostsSetCalls = 0;
  runtimeSwitchCalls = 0;
  sessionStatusOk = false;
  homeReady = true;
  ensureHomeCalls = 0;
  homeResolutionHangs = false;
  finishHomeResolution = () => undefined;
  authSessionState = 'ok';
  markAuthenticatedCalls = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      isSecureContext: false,
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
      setTimeout: (callback: () => void) => {
        queueMicrotask(callback);
        return 0;
      },
      clearTimeout: () => undefined,
    },
  });
};

/** Timers the gate starts never fire, as when the test outruns them. */
const holdTimers = () => {
  Object.assign(window, { setTimeout: () => 0 });
};

const shallowEqualDeps = (left?: unknown[], right?: unknown[]): boolean => {
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
};

const getHookRecord = (): HookRecord => {
  if (!currentRecord) {
    throw new Error('Hooks can only run during a render pass');
  }
  return currentRecord;
};

const renderComponent = <Props extends object>(component: Component<Props>, props: Props): TestNode => {
  const previousRecord = currentRecord;
  const previousHookIndex = hookIndex;
  let record = hookRecords.get(component);
  if (!record) {
    record = { values: [], deps: [] };
    hookRecords.set(component, record);
  }
  currentRecord = record;
  hookIndex = 0;

  try {
    return component(props);
  } finally {
    currentRecord = previousRecord;
    hookIndex = previousHookIndex;
  }
};

function useCallback<Args extends never[], Result>(callback: (...args: Args) => Result, deps?: unknown[]): (...args: Args) => Result {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.values[index] = callback;
    record.deps[index] = deps;
  }
  // SAFETY: This hook slot is only ever written with the callback passed to this hook index.
  return record.values[index] as (...args: Args) => Result;
}

function useEffect(effect: HookEffect, deps?: unknown[]): void {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.deps[index] = deps;
    pendingEffects.push(() => {
      effect();
    });
  }
}

function useMemo<Value>(factory: () => Value, deps?: unknown[]): Value {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.values[index] = factory();
    record.deps[index] = deps;
  }
  // SAFETY: This hook slot is only ever written with the value returned by this hook's factory.
  return record.values[index] as Value;
}

function useRef<Value>(initialValue: Value): { current: Value } {
  const record = getHookRecord();
  const index = hookIndex++;
  if (record.values[index] === undefined) {
    record.values[index] = { current: initialValue };
  }
  // SAFETY: This hook slot is initialized once with a ref container and never reassigned.
  return record.values[index] as { current: Value };
}

function useState<Value>(initialValue: Value | (() => Value)): [Value, (next: Value | ((prev: Value) => Value)) => void] {
  const record = getHookRecord();
  const index = hookIndex++;
  if (record.values[index] === undefined) {
    record.values[index] = initialValue instanceof Function ? initialValue() : initialValue;
  }

  return [
    // SAFETY: This hook slot is initialized and subsequently written only with Value.
    record.values[index] as Value,
    (next) => {
      // SAFETY: This hook slot contains Value, and Function values follow React's updater contract.
      record.values[index] = next instanceof Function
        ? (next as (prev: Value) => Value)(record.values[index] as Value)
        : next;
    },
  ];
}

const fragment = Symbol('Fragment');

const jsx = <Props extends object>(type: Component<Props> | string | symbol, props: Props & ElementProps): TestNode => {
  if (type === fragment) {
    return props.children ?? null;
  }

  if (type instanceof Function) {
    return renderComponent(type, props);
  }

  return { type, props };
};

const ReactMock = {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
};

const reactJsxRuntime = {
  Fragment: fragment,
  jsx,
  jsxs: jsx,
  jsxDEV: jsx,
};

let desktopShell = false;
let runtimeFetchRejects = true;
let sessionStatusOk = false;
let homeReady = true;
let ensureHomeCalls = 0;
let homeResolutionHangs = false;
let finishHomeResolution: () => void = () => undefined;
let runtimeApiBaseUrl = '';
let runtimeKey = 'local';
let runtimeEndpointChangedListener: (() => void) | null = null;
let desktopInvoke: () => Promise<DesktopInvokeResult | null> = async () => null;
let desktopHostsGetCalls = 0;
let desktopHostsSetCalls = 0;
let runtimeSwitchCalls = 0;

mock.module('react/jsx-runtime', () => reactJsxRuntime);
mock.module('react/jsx-dev-runtime', () => reactJsxRuntime);

mock.module('react', () => ({
  __esModule: true,
  default: ReactMock,
  ...ReactMock,
}));

mock.module('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: mock(() => false),
}));

mock.module('@/components/ui/button', () => ({
  Button: ({ children }: ElementProps) => children ?? null,
}));

mock.module('@/components/ui/checkbox', () => ({
  Checkbox: () => null,
}));

mock.module('@/components/ui/input', () => ({
  Input: (props: ElementProps) => jsx('input', props),
}));

mock.module('@/components/ui', () => ({
  toast: {
    success: mock(() => undefined),
    error: mock(() => undefined),
    message: mock(() => undefined),
  },
}));

mock.module('@/components/ui/OpenChamberLogo', () => ({
  OpenChamberLogo: () => 'logo',
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: () => null,
}));

mock.module('@/components/desktop/DesktopHostSwitcher', () => ({
  DesktopHostSwitcherInline: () => 'host-switcher',
}));

mock.module('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

mock.module('@/lib/desktop', () => ({
  invokeDesktop: () => desktopInvoke(),
  isDesktopShell: mock(() => desktopShell),
  isVSCodeRuntime: mock(() => false),
}));

mock.module('@/lib/persistence', () => ({
  initializeAppearancePreferences: mock(() => Promise.resolve()),
  syncDesktopSettings: mock(() => Promise.resolve()),
}));

mock.module('@/lib/directoryPersistence', () => ({
  applyPersistedDirectoryPreferences: mock(() => Promise.resolve()),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => {
    if (runtimeFetchRejects) {
      throw new Error('offline');
    }

    return new Response(JSON.stringify({ authenticated: sessionStatusOk }), {
      status: sessionStatusOk ? 200 : 401,
      headers: { 'content-type': 'application/json' },
    });
  }),
}));

mock.module('@/stores/useDirectoryStore', () => ({
  ensureHomeDirectoryResolved: () => {
    ensureHomeCalls += 1;
    if (homeReady && !homeResolutionHangs) return Promise.resolve();
    return new Promise<void>((resolve) => {
      finishHomeResolution = () => {
        homeReady = true;
        resolve();
      };
    });
  },
  useDirectoryStore: { getState: () => ({ isHomeReady: homeReady }) },
}));

mock.module('@/lib/runtime-auth', () => ({
  getRuntimeExtraHeadersSync: mock(() => ({})),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: () => runtimeApiBaseUrl,
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    runtimeEndpointChangedListener = listener;
    return () => {
      if (runtimeEndpointChangedListener === listener) runtimeEndpointChangedListener = null;
    };
  },
  switchRuntimeEndpoint: () => { runtimeSwitchCalls += 1; },
}));

mock.module('@/lib/desktopHosts', () => ({
  desktopHostsGet: () => {
    desktopHostsGetCalls += 1;
    return Promise.resolve(null);
  },
  desktopHostsSet: () => {
    desktopHostsSetCalls += 1;
    return Promise.resolve();
  },
  getDesktopHostApiUrl: mock(() => ''),
  normalizeHostUrl: mock(() => ''),
}));

mock.module('@/lib/passkeys', () => ({
  authenticateWithPasskey: mock(() => Promise.resolve(null)),
  cancelPasskeyCeremony: mock(() => undefined),
  defaultPasskeyStatus: { enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null },
  fetchPasskeyStatus: mock(() => Promise.resolve({ enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null })),
  isPasskeyCeremonyAbort: mock(() => false),
  registerCurrentDevicePasskey: mock(() => Promise.resolve(null)),
}));

let authSessionState: AuthSessionState = 'ok';
let markAuthenticatedCalls = 0;
const authSessionStore = {
  get state() {
    return authSessionState;
  },
  markAuthenticated: () => {
    markAuthenticatedCalls += 1;
    authSessionState = 'ok';
  },
};

mock.module('@/lib/runtime-auth-expiry', () => ({
  installAuthSessionFocusWatch: mock(() => undefined),
  useAuthSessionStore: Object.assign(
    <Value,>(selector: (store: typeof authSessionStore) => Value) => selector(authSessionStore),
    { getState: () => authSessionStore },
  ),
}));

const { SessionAuthGate } = await import('../../../../src/components/auth/SessionAuthGate');
// SAFETY: SessionAuthGate renders through the mocked JSX runtime above, so its React output is a TestNode tree.
const SessionAuthGateHarness = SessionAuthGate as Component<GateProps>;

const flushEffects = async () => {
  while (pendingEffects.length > 0) {
    const effects = pendingEffects;
    pendingEffects = [];
    for (const effect of effects) {
      effect();
    }
    await Promise.resolve();
  }
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
};

const renderGate = async (): Promise<TestNode> => {
  const firstPass = renderComponent(SessionAuthGateHarness, { children: 'child' });
  await flushEffects();
  const secondPass = renderComponent(SessionAuthGateHarness, { children: 'child' });
  await flushEffects();
  return secondPass ?? firstPass;
};

const collectText = (node: TestNode): string => {
  if (node == null || node === true || node === false) return '';
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  if (node instanceof Object) return collectText(node.props.children);
  return String(node);
};

const findElement = (node: TestNode, type: string): ElementNode | null => {
  if (node == null || node === true || node === false) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, type);
      if (match) return match;
    }
    return null;
  }
  if (!(node instanceof Object)) return null;
  if (node.type === type) return node;
  return findElement(node.props.children, type);
};

describe('SessionAuthGate status-check failure behavior', () => {
  test('keeps non-desktop status-check rejection on the error screen', async () => {
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = true;

    const tree = await renderGate();
    const text = collectText(tree);

    expect(text).toContain('sessionAuth.error.networkTitle');
    expect(text).not.toContain('sessionAuth.locked.unlockTitle');
  });

  test('keeps desktop-shell status-check rejection on the error screen, never a guessed password prompt', async () => {
    resetHarness();
    desktopShell = true;
    runtimeFetchRejects = true;

    const tree = await renderGate();
    const text = collectText(tree);

    expect(text).toContain('sessionAuth.error.networkTitle');
    expect(text).not.toContain('sessionAuth.locked.unlockTitle');
    // A network failure says nothing about the server, so the desktop error
    // screen keeps its real escape hatches: retry and the host switcher.
    expect(text).toContain('host-switcher');
  });

  test('a login that finds the session alive releases the expired state', async () => {
    // The user logged in from another tab, then pressed "Log in" on this tab's banner.
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = false;
    sessionStatusOk = true;

    expect(collectText(await renderGate())).toContain('child');
    expect(markAuthenticatedCalls).toBe(0);

    authSessionState = 'reauthenticating';
    expect(collectText(await renderGate())).toContain('child');

    expect(markAuthenticatedCalls).toBe(1);
    expect(authSessionState).toBe('ok');
  });

  test('keeps the app unmounted until the home directory is known after login', async () => {
    // First visit to a password-protected server: the page-load attempt could
    // not read the home directory, so it is still unknown at login.
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = false;
    sessionStatusOk = true;
    homeReady = false;
    holdTimers();

    expect(collectText(await renderGate())).not.toContain('child');
    expect(ensureHomeCalls).toBe(1);

    finishHomeResolution();
    await flushEffects();
    expect(collectText(await renderGate())).toContain('child');
    expect(ensureHomeCalls).toBe(1);
  });

  test('a home resolution that never settles holds the app back only until the wait runs out', async () => {
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = false;
    sessionStatusOk = true;
    homeReady = false;
    homeResolutionHangs = true;

    await renderGate();
    // The harness fires timers at once, so the wait has already run out.
    await flushEffects();
    expect(collectText(renderComponent(SessionAuthGateHarness, { children: 'child' }))).toContain('child');
    expect(ensureHomeCalls).toBe(1);
  });

  test('shows the app at once when the home directory is already known', async () => {
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = false;
    sessionStatusOk = true;
    // Even a resolution that never settles must not hold back a known home.
    homeResolutionHangs = true;

    expect(collectText(await renderGate())).toContain('child');
  });

  test('discards a password completion after switching to another host', async () => {
    resetHarness();
    desktopShell = true;
    runtimeFetchRejects = false;
    runtimeApiBaseUrl = 'https://host-a.example';
    runtimeKey = 'host:a';
    let resolveLogin: (value: DesktopInvokeResult) => void = () => {
      throw new Error('Password login did not start');
    };
    desktopInvoke = () => new Promise((resolve) => { resolveLogin = resolve; });

    const lockedTree = await renderGate();
    const input = findElement(lockedTree, 'input');
    expect(input).not.toBeNull();
    if (!input) throw new Error('Password input not found');
    input.props.onChange?.({ target: { value: 'password-a' } });

    const passwordTree = await renderGate();
    const form = findElement(passwordTree, 'form');
    expect(form).not.toBeNull();
    if (!form) throw new Error('Password form not found');
    const pending = form.props.onSubmit?.({ preventDefault: () => undefined });
    await Promise.resolve();

    runtimeApiBaseUrl = 'https://host-b.example';
    runtimeKey = 'host:b';
    runtimeEndpointChangedListener?.();
    resolveLogin({ token: 'token-a' });
    await pending;

    expect(desktopHostsGetCalls).toBe(0);
    expect(desktopHostsSetCalls).toBe(0);
    expect(runtimeSwitchCalls).toBe(0);
  });
});
