import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseTrackedItem, trackedItemCandidateSchema, trackedItemStateSchema } from './items.js';
const FILE_NAME = 'tracked-items.json';
const VERSION = 1;
const persistedItemSchema = z.object({
    item: trackedItemCandidateSchema,
    state: trackedItemStateSchema.nullish().catch(null),
    fetchedAt: z.number().finite(),
});
const persistedFileSchema = z.object({
    version: z.number(),
    items: z.array(z.unknown()),
});
/**
 * The last known state of followed items, so a restart starts from it. Only
 * a cache: a missing, unreadable or malformed file restores nothing, and the
 * next answers rebuild it.
 */
export function createTrackedItemsPersistence({ dataDir, fs = fsPromises, }) {
    const filePath = path.join(dataDir, FILE_NAME);
    return {
        async load() {
            let raw;
            try {
                raw = await fs.readFile(filePath, 'utf8');
            }
            catch (cause) {
                if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')
                    return [];
                throw cause;
            }
            const parsed = JSON.parse(raw);
            const file = persistedFileSchema.safeParse(parsed);
            if (!file.success || file.data.version !== VERSION)
                return [];
            return file.data.items.flatMap((record) => {
                const decoded = persistedItemSchema.safeParse(record);
                if (!decoded.success)
                    return [];
                const item = parseTrackedItem(decoded.data.item);
                if (!item)
                    return [];
                return [{ item, state: decoded.data.state ?? null, fetchedAt: decoded.data.fetchedAt }];
            });
        },
        async save(items) {
            // Temp file in the same directory, so the rename is atomic on one device.
            const tmpPath = `${filePath}.${process.pid}.tmp`;
            await fs.writeFile(tmpPath, JSON.stringify({ version: VERSION, items }), 'utf8');
            await fs.rename(tmpPath, filePath);
        },
    };
}
