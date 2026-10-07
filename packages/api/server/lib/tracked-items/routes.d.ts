import type { Express } from 'express';
import type { TrackedItem, TrackedItemPublicState } from './items.js';
/** The slice of the service these routes call, so tests can stand in for it. */
export interface TrackedItemsRouteService {
    ready(): Promise<void>;
    setInterest(connectionId: string, items: Map<string, TrackedItem>, options: {
        visible: boolean;
    }): TrackedItemPublicState[];
    setPresence(connectionId: string, visible: boolean): void;
    refresh(items: TrackedItem[]): void;
}
/**
 * `POST /api/tracked-items/interest` replaces what one event-stream connection
 * shows and answers with what is already known; changes then arrive as
 * `openchamber:tracked-items.changed` on that connection. Presence and refresh
 * are single signals, sent when they happen, never on a timer.
 */
export declare function registerTrackedItemsRoutes(app: Express, { service }: {
    service: TrackedItemsRouteService;
}): void;
