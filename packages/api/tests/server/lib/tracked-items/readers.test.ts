import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@opencode/client';
import { createTrackedItemReaders } from '../../../../server/lib/tracked-items/readers.js';
import type {
  GitHubRateLimitModule,
  GitHubSummariesModule,
  GitLabLiveSummariesReader,
  LinearReaderModule,
  ProviderError,
} from '../../../../server/lib/tracked-items/readers.js';

const rateLimitModule = (limited = false): GitHubRateLimitModule => ({
  isGitHubRateLimited: () => limited,
  isGitHubRateLimitError: (error) => error.status === 429,
  noteGitHubRateLimit: vi.fn(),
});

const readersWith = ({
  octokit = {},
  fetchPrSummaries = vi.fn(async () => ({ summaries: [{ number: 1 }], issueSummaries: [] })),
  limited = false,
  rateLimit,
  graphqlRateLimit = () => false,
  gitlab,
  linear,
}: {
  octokit?: JsonValue;
  fetchPrSummaries?: GitHubSummariesModule['fetchPrSummaries'];
  limited?: boolean;
  rateLimit?: GitHubRateLimitModule;
  graphqlRateLimit?: (error: ProviderError) => boolean;
  gitlab?: GitLabLiveSummariesReader;
  linear?: LinearReaderModule['getLinearIssueSummaries'];
} = {}) => createTrackedItemReaders({
  loadGitHub: async () => ({ getOctokitOrNull: async () => octokit, getOctokitForAccountId: async (accountId) => (accountId === 'bound' ? { octokit: { bound: true } } : null) }),
  loadGitHubSummaries: async () => ({ fetchPrSummaries, isGraphqlRateLimitError: graphqlRateLimit }),
  loadGitHubRateLimit: async () => rateLimit ?? rateLimitModule(limited),
  loadLinear: async () => ({ getLinearIssueSummaries: linear ?? (async () => ({ connected: false })) }),
  readGitLabLiveSummaries: gitlab,
});

describe('tracked item readers', () => {
  it('reads GitHub with the current account and says why when it cannot', async () => {
    const fetchPrSummaries = vi.fn(async () => ({ summaries: [{ number: 1 }], issueSummaries: [{ number: 2 }] }));
    await expect(readersWith({ fetchPrSummaries }).github({ pulls: [{ owner: 'a', repo: 'b', number: 1 }], issues: [] }))
      .resolves.toEqual({ status: 'ok', pulls: [{ number: 1 }], issues: [{ number: 2 }] });
    await expect(readersWith({ octokit: null }).github({ pulls: [], issues: [] })).resolves.toEqual({ status: 'disconnected' });
    // A bound repository's account answers for its own pull requests.
    await readersWith({ fetchPrSummaries }).github({ accountId: 'bound', pulls: [], issues: [] });
    expect(fetchPrSummaries).toHaveBeenLastCalledWith({ octokit: { bound: true }, refs: [], issueRefs: [] });
    await expect(readersWith().github({ accountId: 'gone', pulls: [], issues: [] })).resolves.toEqual({ status: 'disconnected' });
    await expect(readersWith({ limited: true }).github({ pulls: [], issues: [] })).resolves.toEqual({ status: 'unavailable' });
    const limitedNow = vi.fn(async () => { throw Object.assign(new Error('limit'), { status: 429 }); });
    await expect(readersWith({ fetchPrSummaries: limitedNow }).github({ pulls: [], issues: [] })).resolves.toEqual({ status: 'unavailable' });
  });

  it('reads a thrown non-Error the same way: a plain-object status is not lost', async () => {
    const plain401 = vi.fn(async () => { throw { status: 401 }; });
    await expect(readersWith({ fetchPrSummaries: plain401 }).github({ pulls: [], issues: [] })).resolves.toEqual({ status: 'disconnected' });
    const nested401 = vi.fn(async () => { throw { response: { status: 401 } }; });
    await expect(readersWith({ fetchPrSummaries: nested401 }).github({ pulls: [], issues: [] })).resolves.toEqual({ status: 'disconnected' });
    const plain429 = vi.fn(async () => { throw { status: 429 }; });
    await expect(readersWith({ fetchPrSummaries: plain429 }).github({ pulls: [], issues: [] })).resolves.toEqual({ status: 'unavailable' });
  });

  it('passes a decoded plain-object GraphQL error to the recognizer', async () => {
    const graphqlLimit = vi.fn(async () => { throw { errors: [{ message: 'rate limit' }] }; });
    const recognized = vi.fn((error: ProviderError) => Array.isArray(error.errors));
    await expect(readersWith({ fetchPrSummaries: graphqlLimit, graphqlRateLimit: recognized }).github({ pulls: [], issues: [] }))
      .resolves.toEqual({ status: 'unavailable' });
    expect(recognized).toHaveBeenCalledWith({ errors: [{ message: 'rate limit' }] });
  });

  it('preserves rate-limit headers on thrown provider errors', async () => {
    const noteGitHubRateLimit = vi.fn();
    const rateLimit: GitHubRateLimitModule = {
      isGitHubRateLimited: () => false,
      isGitHubRateLimitError: (error) => error.response?.status === 403,
      noteGitHubRateLimit,
    };
    const headers = { 'x-ratelimit-remaining': '0', 'retry-after': '2' };
    const thrown = { response: { status: 403, headers } };
    const fetchPrSummaries = vi.fn(async () => { throw thrown; });
    await expect(readersWith({ fetchPrSummaries, rateLimit }).github({ pulls: [], issues: [] }))
      .resolves.toEqual({ status: 'unavailable' });
    expect(noteGitHubRateLimit).toHaveBeenCalledWith(thrown);

    const responseHeaders = new Headers({ 'x-ratelimit-remaining': '0' });
    const headersError = { response: { status: 403, headers: responseHeaders } };
    const fetchWithHeaders = vi.fn(async () => { throw headersError; });
    await expect(readersWith({ fetchPrSummaries: fetchWithHeaders, rateLimit }).github({ pulls: [], issues: [] }))
      .resolves.toEqual({ status: 'unavailable' });
    expect(noteGitHubRateLimit).toHaveBeenLastCalledWith(headersError);
  });

  it('rethrows a thrown value it cannot decode', async () => {
    const thrown = vi.fn(async () => { throw 'boom'; });
    await expect(readersWith({ fetchPrSummaries: thrown }).github({ pulls: [], issues: [] })).rejects.toBe('boom');
  });

  it('maps GitLab and Linear answers into the same terms', async () => {
    const gitlab = vi.fn(async () => ({ connected: true, summaries: [{ number: 3 }], issueSummaries: [] }));
    await expect(readersWith({ gitlab }).gitlab({ instance: 'https://gitlab.com', pulls: [{ owner: 'g', repo: 'r', number: 3 }], issues: [] }))
      .resolves.toEqual({ status: 'ok', pulls: [{ number: 3 }], issues: [] });
    expect(gitlab).toHaveBeenCalledWith({ instance: 'https://gitlab.com', accountId: null, refs: [{ owner: 'g', repo: 'r', number: 3 }], issueRefs: [] });
    await expect(readersWith({ gitlab: async () => ({ connected: false }) }).gitlab({ instance: 'https://gitlab.com', pulls: [], issues: [] }))
      .resolves.toEqual({ status: 'disconnected' });
    await expect(readersWith({ linear: async () => ({ connected: true, issues: [{ identifier: 'OPE-1' }] }) }).linear({ identifiers: ['OPE-1'] }))
      .resolves.toEqual({ status: 'ok', issues: [{ identifier: 'OPE-1' }] });
  });
});
