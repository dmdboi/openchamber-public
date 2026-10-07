// Node exposes `navigator` as a getter-only global. UI suites install a
// happy-dom window with `Object.assign(globalThis, { navigator: ... })`, which
// needs a writable data property rather than the accessor Node defines.
Object.defineProperty(globalThis, 'navigator', {
  value: globalThis.navigator,
  writable: true,
  configurable: true,
});
