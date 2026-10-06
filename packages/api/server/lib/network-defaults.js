import net from 'node:net';

// Node caps each happy-eyeballs connect attempt at 250ms by default
// (autoSelectFamilyAttemptTimeout). TCP handshakes to provider endpoints that are
// geographically distant routinely take 300-1500ms, so fetch() from a Node process
// aborts every attempt (ETIMEDOUT) and surfaces "fetch failed" even though the host
// is reachable — e.g. the z.ai quota endpoint from an IPv4-only egress (#3399).
//
// Every Node process entrypoint that performs provider fetches raises the
// per-attempt cap. Family autoselection itself stays enabled, so the IPv6→IPv4
// fallback and ::1/localhost servers keep working; disabling it instead breaks
// local MCP servers. Runtimes without the setter (Bun's fetch path, older Node)
// are a no-op.
/**
 * Per-attempt connect timeout applied to Node's happy-eyeballs family
 * autoselection, in milliseconds.
 * @type {number}
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;

/**
 * Raises Node's per-attempt connect timeout so distant provider endpoints can
 * finish their TCP handshake. Address-family autoselection stays enabled, and
 * runtimes without the setter are a no-op.
 *
 * @param {Partial<Pick<typeof net, 'setDefaultAutoSelectFamilyAttemptTimeout'>>} [netModule]
 *   The `node:net` surface to configure; injectable for tests.
 * @returns {boolean} `true` when the timeout was applied, `false` when the
 *   runtime lacks the setter or the setter throws.
 */
export const applyConnectAttemptTimeout = (netModule = net) => {
  try {
    netModule.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
};
