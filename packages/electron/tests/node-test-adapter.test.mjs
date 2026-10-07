import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

// Exercises the node:test surface the converted suites use, through the
// `node:test` -> test-shims/node-test.ts alias, so a regression in the adapter
// fails here instead of silently changing test semantics.
const order = [];

describe('node:test adapter', () => {
  test('honors the (name, options, body) skip form', { skip: true }, () => {
    throw new Error('a skipped test must not run');
  });

  test('runs t.after hooks after the body', (t) => {
    order.push('body');
    t.after(() => order.push('after'));
  });

  test('observes the previous test after hook before starting', () => {
    assert.deepEqual(order, ['body', 'after']);
  });

  test('advances timers through t.mock.timers', (t) => {
    t.mock.timers.enable();
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 100);
    t.mock.timers.tick(100);
    assert.equal(fired, true);
    t.mock.timers.reset();
  });
});
