import { describe, expect, it, vi } from 'vitest';
import { createTrackedItemsPersistence } from '../../../../server/lib/tracked-items/persistence.js';
import type { TrackedItemsPersistenceFs } from '../../../../server/lib/tracked-items/persistence.js';
import type { TrackedItem } from '../../../../server/lib/tracked-items/items.js';

const fsWith = (content: string | Error): TrackedItemsPersistenceFs => ({
  readFile: vi.fn(async () => {
    if (content instanceof Error) throw content;
    return content;
  }),
  writeFile: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
});

const pull = (number: number): TrackedItem => ({ provider: 'github', kind: 'pull', owner: 'acme', repo: 'app', number });

describe('tracked items persistence', () => {
  it('restores valid records and drops a malformed one', async () => {
    const file = JSON.stringify({
      version: 1,
      items: [
        { item: pull(1), state: { state: 'open' }, fetchedAt: 5 },
        { item: { provider: 'github' }, fetchedAt: 5 },
        { item: pull(2), fetchedAt: 'nope' },
        { item: pull(3), state: { state: 'open' }, fetchedAt: 6 },
      ],
    });
    const records = await createTrackedItemsPersistence({ dataDir: '/data', fs: fsWith(file) }).load();
    expect(records.map((record) => record.item)).toEqual([pull(1), pull(3)]);
    expect(records[0].state).toEqual({ state: 'open' });
  });

  it('restores nothing from a missing, wrong-version or non-JSON file', async () => {
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    expect(await createTrackedItemsPersistence({ dataDir: '/data', fs: fsWith(enoent) }).load()).toEqual([]);
    expect(await createTrackedItemsPersistence({ dataDir: '/data', fs: fsWith(JSON.stringify({ version: 2, items: [] })) }).load()).toEqual([]);
    await expect(createTrackedItemsPersistence({ dataDir: '/data', fs: fsWith('not json') }).load()).rejects.toThrow();
  });

  it('writes through a temp file and renames it into place', async () => {
    const fs = fsWith('{}');
    await createTrackedItemsPersistence({ dataDir: '/data', fs }).save([{ key: 'k', item: pull(1), state: null, fetchedAt: 1 }]);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.rename).toHaveBeenCalledTimes(1);
  });
});
