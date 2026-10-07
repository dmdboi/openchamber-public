import express from 'express';
import { z } from 'zod';
import { parseTrackedItems, trackedItemCandidateSchema } from './items.js';
// One client shows at most this many linked items at once; the sidebar of a
// large workspace stays far below it.
const MAX_ITEMS = 300;
const itemsSchema = z.array(trackedItemCandidateSchema);
const interestBodySchema = z.object({
    connectionId: z.string().trim().min(1),
    visible: z.boolean().optional(),
    items: itemsSchema,
});
const presenceBodySchema = z.object({
    connectionId: z.string().trim().min(1),
    visible: z.boolean(),
});
const refreshBodySchema = z.object({
    items: itemsSchema,
});
/**
 * `POST /api/tracked-items/interest` replaces what one event-stream connection
 * shows and answers with what is already known; changes then arrive as
 * `openchamber:tracked-items.changed` on that connection. Presence and refresh
 * are single signals, sent when they happen, never on a timer.
 */
export function registerTrackedItemsRoutes(app, { service }) {
    const json = express.json({ limit: '128kb' });
    app.post('/api/tracked-items/interest', json, async (req, res) => {
        // A request body is unknown until decoded; Express types it as `any`.
        const body = req.body;
        const decoded = interestBodySchema.safeParse(body);
        const items = decoded.success ? parseTrackedItems(decoded.data.items, MAX_ITEMS) : null;
        if (!decoded.success || !items) {
            res.status(400).json({ error: `connectionId and at most ${MAX_ITEMS} items are required` });
            return;
        }
        await service.ready();
        try {
            res.json({ states: service.setInterest(decoded.data.connectionId, items, { visible: decoded.data.visible !== false }) });
        }
        catch (cause) {
            if (cause instanceof Error && 'code' in cause && cause.code === 'unknown-connection') {
                res.status(409).json({ error: cause.message, code: cause.code });
                return;
            }
            throw cause;
        }
    });
    app.post('/api/tracked-items/presence', json, (req, res) => {
        const body = req.body;
        const decoded = presenceBodySchema.safeParse(body);
        if (!decoded.success) {
            res.status(400).json({ error: 'connectionId and visible are required' });
            return;
        }
        service.setPresence(decoded.data.connectionId, decoded.data.visible);
        res.json({ ok: true });
    });
    app.post('/api/tracked-items/refresh', json, (req, res) => {
        const body = req.body;
        const decoded = refreshBodySchema.safeParse(body);
        const items = decoded.success ? parseTrackedItems(decoded.data.items, MAX_ITEMS) : null;
        if (!items) {
            res.status(400).json({ error: `at most ${MAX_ITEMS} items are required` });
            return;
        }
        service.refresh([...items.values()]);
        res.json({ ok: true });
    });
}
