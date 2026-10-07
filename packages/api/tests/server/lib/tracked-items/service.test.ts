import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTrackedItems, trackedItemKey, trackedItemsSchema } from '../../../../server/lib/tracked-items/items.js';
import type { TrackedItem, TrackedItemState } from '../../../../server/lib/tracked-items/items.js';
import { createTrackedItemsService } from '../../../../server/lib/tracked-items/service.js';
import type { TrackedItemsChangedEvent } from '../../../../server/lib/tracked-items/service.js';
import type { TrackedItemsPersistence } from '../../../../server/lib/tracked-items/persistence.js';
import type {
  TrackedGithubReadInput,
  TrackedGitlabReadInput,
  TrackedLinearReadInput,
  TrackedReaderAnswer,
  TrackedReaderAnswers,
  TrackedThreadRef,
} from '../../../../server/lib/tracked-items/readers.js';

const githubPull = (number: number): TrackedItem => ({ provider: 'github', kind: 'pull', owner: 'acme', repo: 'app', number });
const githubIssue = (number: number): TrackedItem => ({ provider: 'github', kind: 'issue', owner: 'acme', repo: 'app', number });
const gitlabPull = (number: number): TrackedItem => ({ provider: 'gitlab', instance: 'https://gitlab.com', kind: 'pull', owner: 'group/sub', repo: 'app', number });
const linearIssue = (identifier: string): TrackedItem => ({ provider: 'linear', identifier });

const itemsOf = (...items: TrackedItem[]): Map<string, TrackedItem> => {
  const parsed = parseTrackedItems(items, 100);
  if (!parsed) throw new Error('test items did not parse');
  return parsed;
};

const pullSummary = (ref: TrackedThreadRef, state = 'open', extra: TrackedItemState = {}) => ({
  ...ref, state, draft: false, title: `PR ${ref.number}`, mergeable: null, mergeableState: null, checks: null, ...extra,
});

function setup({ readers = {}, persistence = null }: {
  readers?: Partial<TrackedReaderAnswers>;
  persistence?: TrackedItemsPersistence | null;
} = {}) {
  const open = new Set(['c1', 'c2']);
  const sent: Array<{ id: string; event: TrackedItemsChangedEvent }> = [];
  const githubCalls: TrackedGithubReadInput[] = [];
  const gitlabCalls: TrackedGitlabReadInput[] = [];
  const linearCalls: TrackedLinearReadInput[] = [];
  const calls = { github: githubCalls, gitlab: gitlabCalls, linear: linearCalls };
  const defaults: TrackedReaderAnswers = {
    github: async (input) => ({ status: 'ok', pulls: input.pulls.map((ref) => pullSummary(ref)), issues: input.issues.map((ref) => ({ ...ref, title: 'Issue', state: 'open' })) }),
    gitlab: async (input) => ({ status: 'ok', pulls: input.pulls.map((ref) => pullSummary(ref)), issues: [] }),
    linear: async (input) => ({ status: 'ok', issues: input.identifiers.map((identifier) => ({ identifier, title: identifier, state: { name: 'Todo', type: 'unstarted' } })) }),
  };
  const answers: TrackedReaderAnswers = { ...defaults, ...readers };
  const service = createTrackedItemsService({
    readers: {
      github: (input) => { githubCalls.push(input); return answers.github(input); },
      gitlab: (input) => { gitlabCalls.push(input); return answers.gitlab(input); },
      linear: (input) => { linearCalls.push(input); return answers.linear(input); },
    },
    send: (id, event) => { if (!open.has(id)) return false; sent.push({ id, event }); return true; },
    isConnectionOpen: (id) => open.has(id),
    persistence,
    log: { warn: () => {} },
  });
  return { service, sent, calls, open };
}

describe('tracked items service', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks each provider once per batch for a visible client and pushes only to the clients that show the item', async () => {
    const { service, sent, calls } = setup();
    service.setInterest('c1', itemsOf(githubPull(1), githubIssue(2), gitlabPull(3), linearIssue('ope-7')));
    service.setInterest('c2', itemsOf(githubPull(9)));
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.github).toHaveLength(1);
    expect(calls.github[0]).toEqual({
      accountId: null,
      pulls: [{ owner: 'acme', repo: 'app', number: 1 }, { owner: 'acme', repo: 'app', number: 9 }],
      issues: [{ owner: 'acme', repo: 'app', number: 2 }],
    });
    expect(calls.gitlab[0]).toMatchObject({ instance: 'https://gitlab.com', pulls: [{ owner: 'group/sub', repo: 'app', number: 3 }] });
    expect(calls.linear[0]).toEqual({ identifiers: ['OPE-7'] });
    const keysFor = (id: string) => sent.filter((entry) => entry.id === id).flatMap((entry) => entry.event.properties.states.map((state) => state.key)).sort();
    expect(keysFor('c1')).toEqual([githubPull(1), githubIssue(2), gitlabPull(3), linearIssue('OPE-7')].map(trackedItemKey).sort());
    expect(keysFor('c2')).toEqual([trackedItemKey(githubPull(9))]);
  });

  it('stays quiet while nothing changed and while the client is hidden, and catches up when it returns', async () => {
    const { service, sent, calls } = setup();
    service.setInterest('c1', itemsOf(githubPull(1)));
    await vi.advanceTimersByTimeAsync(0);
    sent.length = 0;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.github).toHaveLength(2);
    expect(sent).toHaveLength(0);

    service.setPresence('c1', false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls.github).toHaveLength(2);

    service.setPresence('c1', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.github).toHaveLength(3);
  });

  it('keeps the last known state through a failed read and backs off before asking again', async () => {
    let fail = false;
    const { service, sent, calls } = setup({
      readers: { github: async (input) => (fail ? Promise.reject(new Error('down')) : { status: 'ok', pulls: input.pulls.map((ref) => pullSummary(ref)), issues: [] }) },
    });
    service.setInterest('c1', itemsOf(githubPull(1)));
    await vi.advanceTimersByTimeAsync(0);
    fail = true;
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.github).toHaveLength(2);
    expect(sent).toHaveLength(0);
    // Backed off for 30 s past the failure, not asked at the next minute boundary early.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls.github).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.github).toHaveLength(3);
  });

  it('keeps the last known state and backs off when a reader answers nothing or answers malformed', async () => {
    let answer: TrackedReaderAnswer = { status: 'ok', pulls: [pullSummary({ owner: 'acme', repo: 'app', number: 1 })], issues: [] };
    const { service, sent, calls } = setup({ readers: { github: async () => answer } });
    service.setInterest('c1', itemsOf(githubPull(1)));
    await vi.advanceTimersByTimeAsync(0);
    sent.length = 0;
    answer = null;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.github).toHaveLength(2);
    // The last known state stays and the answer counts as a failure.
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls.github).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.github).toHaveLength(3);

    // An untyped provider can answer a shape no type describes; `JSON.parse`
    // reproduces that without a cast.
    answer = JSON.parse('{"status":"nonsense"}');
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(0);
  });

  it('never asks about a merged pull request again and clears an item the provider no longer answers', async () => {
    let answerTwo = true;
    const { service, sent, calls } = setup({
      readers: {
        github: async (input) => ({
          status: 'ok',
          pulls: input.pulls.filter((ref) => ref.number !== 2 || answerTwo).map((ref) => pullSummary(ref, ref.number === 1 ? 'merged' : 'open')),
          issues: [],
        }),
      },
    });
    service.setInterest('c1', itemsOf(githubPull(1), githubPull(2)));
    await vi.advanceTimersByTimeAsync(0);
    answerTwo = false;
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.github[1].pulls.map((ref) => ref.number)).toEqual([2]);
    expect(sent[0].event.properties.states).toEqual([expect.objectContaining({ key: trackedItemKey(githubPull(2)), state: null })]);
  });

  it('starts from persisted state and refreshes open items after an agent turn settles', async () => {
    const saved = [{ key: trackedItemKey(githubPull(1)), item: githubPull(1), state: pullSummary({ owner: 'acme', repo: 'app', number: 1 }), fetchedAt: Date.now() - 1000 }];
    const persistence = { load: vi.fn(async () => saved), save: vi.fn(async () => {}) };
    const { service, calls } = setup({ persistence });
    await service.ready();
    const known = service.setInterest('c1', itemsOf(githubPull(1)));
    expect(known).toEqual([expect.objectContaining({ key: saved[0].key, state: saved[0].state })]);
    await vi.advanceTimersByTimeAsync(0);
    const before = calls.github.length;

    service.noteTurnFinished();
    service.noteTurnFinished();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.github.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(calls.github.length).toBe(before + 1);
  });

  it('refuses interest from a connection that is not open and forgets closed ones', async () => {
    const { service, sent, open } = setup();
    expect(() => service.setInterest('gone', itemsOf(githubPull(1)))).toThrow(expect.objectContaining({ code: 'unknown-connection' }));
    service.setInterest('c1', itemsOf(githubPull(1)));
    open.delete('c1');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(0);
  });
});

describe('tracked item parsing', () => {
  it('accepts GitLab subgroups and normalizes keys, and drops what names nothing', () => {
    const parsed = parseTrackedItems([
      gitlabPull(3),
      { ...gitlabPull(3), instance: 'https://GitLab.com/' },
      { provider: 'github', kind: 'pull', owner: 'a/b', repo: 'app', number: 1 },
      { provider: 'linear', identifier: 'not an id' },
      { provider: 'bitbucket', kind: 'pull', owner: 'a', repo: 'b', number: 1 },
    ], 10);
    if (!parsed) throw new Error('expected items to parse');
    expect([...parsed.keys()]).toEqual(['gitlab|https://gitlab.com|pull|group/sub/app#3']);
    // The same pull request read with a bound account is a separate item.
    const bound = parseTrackedItems([{ ...githubPull(1), accountId: 'github.com#7' }, githubPull(1)], 10);
    if (!bound) throw new Error('expected bound items to parse');
    expect([...bound.keys()]).toEqual(['github|pull|acme/app#1@github.com#7', 'github|pull|acme/app#1']);
    expect(parseTrackedItems([], 10)?.size).toBe(0);
    expect(parseTrackedItems([gitlabPull(1), gitlabPull(2)], 1)).toBeNull();
    // The boundary decodes any JSON list; a non-object entry becomes the empty
    // candidate parsing drops, and a non-list fails the decode.
    expect(trackedItemsSchema.safeParse('nope').success).toBe(false);
    const decoded = trackedItemsSchema.safeParse(['nope', githubPull(4)]);
    if (!decoded.success) throw new Error('expected the list to decode');
    const dropped = parseTrackedItems(decoded.data, 10);
    expect(dropped ? [...dropped.keys()] : null).toEqual([trackedItemKey(githubPull(4))]);
  });
});
