import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as net from 'node:net';
import { applyConnectAttemptTimeout as fromVscode } from '../../src/networkDefaults';
import { applyConnectAttemptTimeout as fromWeb } from '../../../web/server/lib/network-defaults.js';

describe('network defaults parity (vscode ↔ web)', () => {
  test('re-exports the web module function instead of copying the algorithm', () => {
    assert.equal(fromVscode, fromWeb);
  });

  test('the shared policy reaches the real Node default through the extension import', () => {
    const previous = net.getDefaultAutoSelectFamilyAttemptTimeout();
    try {
      net.setDefaultAutoSelectFamilyAttemptTimeout(250);
      assert.equal(fromVscode(), true);
      assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 5_000);
    } finally {
      net.setDefaultAutoSelectFamilyAttemptTimeout(previous);
    }
  });
});
