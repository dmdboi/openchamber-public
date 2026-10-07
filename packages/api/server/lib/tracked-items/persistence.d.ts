import type { TrackedItemPublicState, TrackedItemStateRecord } from './items.js';
/** The slice of `node:fs/promises` this store needs, so tests can inject one. */
export interface TrackedItemsPersistenceFs {
    readFile(filePath: string, encoding: 'utf8'): Promise<string>;
    writeFile(filePath: string, data: string, encoding: 'utf8'): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
}
export interface TrackedItemsPersistence {
    load(): Promise<TrackedItemStateRecord[]>;
    save(items: TrackedItemPublicState[]): Promise<void>;
}
/**
 * The last known state of followed items, so a restart starts from it. Only
 * a cache: a missing, unreadable or malformed file restores nothing, and the
 * next answers rebuild it.
 */
export declare function createTrackedItemsPersistence({ dataDir, fs, }: {
    dataDir: string;
    fs?: TrackedItemsPersistenceFs;
}): TrackedItemsPersistence;
