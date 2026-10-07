import { describe, expect, jest, mock, setSystemTime, spyOn, test } from 'bun:test';

// Exercises the bun:test surface the converted suites use, through the
// `bun:test` -> test-shims/bun-test.ts alias.
describe('bun:test adapter', () => {
  test('toStartWith matches a prefix', () => {
    expect('muxclient socket failed').toStartWith('muxclient');
  });

  test('mock() records calls and applies the factory', () => {
    const fn = mock((value) => value + 1);
    expect(fn(1)).toBe(2);
    expect(fn.mock.calls).toHaveLength(1);
  });

  test('spyOn replaces and records a method', () => {
    const target = { greet: () => 'real' };
    const spy = spyOn(target, 'greet').mockReturnValue('mocked');
    expect(target.greet()).toBe('mocked');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('jest fake timers advance time', () => {
    jest.useFakeTimers();
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 50);
    jest.advanceTimersByTime(50);
    expect(fired).toBe(true);
    jest.useRealTimers();
  });

  test('setSystemTime controls the clock', () => {
    jest.useFakeTimers();
    setSystemTime(new Date('2020-01-01T00:00:00Z'));
    expect(new Date().toISOString()).toBe('2020-01-01T00:00:00.000Z');
    jest.useRealTimers();
  });
});
