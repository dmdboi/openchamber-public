import type { TrackedItem, TrackedItemPublicState } from './items.js';
import type { TrackedItemsPersistence } from './persistence.js';
import type { TrackedReaderAnswers } from './readers.js';
export interface TrackedItemsChangedEvent {
    type: 'openchamber:tracked-items.changed';
    properties: {
        states: TrackedItemPublicState[];
    };
}
export interface TrackedItemsServiceLog {
    warn?: (message: string, detail?: string) => void;
}
export interface TrackedItemsServiceDependencies {
    readers: TrackedReaderAnswers;
    send: (connectionId: string, event: TrackedItemsChangedEvent) => boolean;
    isConnectionOpen: (connectionId: string) => boolean;
    persistence?: TrackedItemsPersistence | null;
    now?: () => number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    log?: TrackedItemsServiceLog;
}
/**
 * `readers` answer one provider batch each and never see other providers:
 * - `github({ accountId, pulls, issues })`, `gitlab({ instance, accountId, pulls, issues })` with
 *   `{ owner, repo, number }` refs, answering `{ status: 'ok', pulls, issues }`
 *   in GitHub's summary shape;
 * - `linear({ identifiers })` answering `{ status: 'ok', issues }`;
 * - or `{ status: 'disconnected' }` (no account there) /
 *   `{ status: 'unavailable', retryAfterMs? }` (rate limit, outage). A throw
 *   counts as unavailable.
 * `send(connectionId, event)` returns false when the connection is gone.
 */
export declare function createTrackedItemsService({ readers, send, isConnectionOpen, persistence, now, setTimer, clearTimer, log, }: TrackedItemsServiceDependencies): {
    /** Resolves once the persisted state has been read (or failed to). */
    ready: () => Promise<void>;
    /**
     * Replaces what one connection shows and answers with what is known of it
     * already. Unknown items are asked about right away when the client is
     * visible. Throws `unknown-connection` for a connection that is not open.
     */
    setInterest(connectionId: string, items: Map<string, TrackedItem>, { visible }?: {
        visible?: boolean;
    }): TrackedItemPublicState[];
    /** A connection's window became visible or hidden. Visible again refreshes what aged past the floor. */
    setPresence(connectionId: string, visible: boolean): void;
    /** Asks about these items now, whatever their age: a user's refresh, our own mutation. */
    refresh(items: TrackedItem[]): void;
    /** An agent turn finished somewhere: anything still open may have moved. */
    noteTurnFinished(): void;
    dispose(): void;
};
export type TrackedItemsService = ReturnType<typeof createTrackedItemsService>;
