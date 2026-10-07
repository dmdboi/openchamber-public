import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerTrackedItemsRoutes } from '../../../../server/lib/tracked-items/routes.js';
import type { TrackedItemsRouteService } from '../../../../server/lib/tracked-items/routes.js';
import type { TrackedItem } from '../../../../server/lib/tracked-items/items.js';

const item: TrackedItem = { provider: 'github', kind: 'pull', owner: 'acme', repo: 'app', number: 1 };

function appWith(service: Partial<TrackedItemsRouteService>) {
  const app = express();
  registerTrackedItemsRoutes(app, {
    service: {
      ready: async () => {},
      setInterest: () => [],
      setPresence: () => {},
      refresh: () => {},
      ...service,
    },
  });
  return app;
}

describe('tracked items routes', () => {
  it('replaces a connection\'s interest and answers with what is known', async () => {
    const setInterest = vi.fn((connectionId: string, items: Map<string, TrackedItem>, options: { visible: boolean }) => {
      void connectionId; void items; void options;
      return [{ key: 'github|pull|acme/app#1', item, state: null, fetchedAt: 1 }];
    });
    const response = await request(appWith({ setInterest })).post('/api/tracked-items/interest')
      .send({ connectionId: 'c1', visible: false, items: [item, { provider: 'nope' }] }).expect(200);
    expect(response.body.states).toHaveLength(1);
    const [connectionId, items, options] = setInterest.mock.calls[0];
    expect([connectionId, [...items.keys()], options]).toEqual(['c1', ['github|pull|acme/app#1'], { visible: false }]);
  });

  it('asks a client on a closed connection to reconnect, and rejects malformed bodies', async () => {
    const setInterest = vi.fn(() => { throw Object.assign(new Error('closed'), { code: 'unknown-connection' }); });
    await request(appWith({ setInterest })).post('/api/tracked-items/interest').send({ connectionId: 'gone', items: [item] }).expect(409);
    await request(appWith({ setInterest })).post('/api/tracked-items/interest').send({ items: [item] }).expect(400);
    await request(appWith({ setPresence: vi.fn() })).post('/api/tracked-items/presence').send({ connectionId: 'c1' }).expect(400);
  });

  it('rejects malformed bodies at the boundary before the service sees them', async () => {
    const app = appWith({});
    await request(app).post('/api/tracked-items/interest').send({ connectionId: 'c1', items: 'nope' }).expect(400);
    await request(app).post('/api/tracked-items/interest').send({ items: [item] }).expect(400);
    await request(app).post('/api/tracked-items/interest').send({ connectionId: '  ', items: [item] }).expect(400);
    await request(app).post('/api/tracked-items/interest').send({ connectionId: 'c1', items: Array.from({ length: 301 }, () => item) }).expect(400);
    await request(app).post('/api/tracked-items/presence').send({ connectionId: 'c1', visible: 'yes' }).expect(400);
    await request(app).post('/api/tracked-items/refresh').send({ items: {} }).expect(400);
  });

  it('passes presence and refresh signals through', async () => {
    const setPresence = vi.fn();
    const refresh = vi.fn();
    const app = appWith({ setPresence, refresh });
    await request(app).post('/api/tracked-items/presence').send({ connectionId: 'c1', visible: true }).expect(200);
    await request(app).post('/api/tracked-items/refresh').send({ items: [item] }).expect(200);
    expect(setPresence).toHaveBeenCalledWith('c1', true);
    expect(refresh).toHaveBeenCalledWith([item]);
  });
});
