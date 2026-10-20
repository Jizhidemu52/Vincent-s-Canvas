import { USAGE_MAX_EVENT_AGE_MS, USAGE_MAX_EVENT_FUTURE_MS, type UsageClientEvent, type UsageEventsResult, type UsageMeResult } from "../../../shared/usage-analytics";
import { createClientUuid } from "./client-uuid";

export type UsageLocalState = { version: 1; counts: Record<string, number>; pending: UsageClientEvent[]; dropped: Record<string, number> };
export type UsageSessionDependencies = {
    read: () => Promise<UsageLocalState | null>; write: (state: UsageLocalState) => Promise<void>;
    post: (events: UsageClientEvent[], signal: AbortSignal) => Promise<UsageEventsResult>;
    me: (signal: AbortSignal) => Promise<UsageMeResult>;
    changed: (counts: Record<string, number>, storageUnavailable: boolean) => void;
    id?: () => string; now?: () => string; maxPending?: number;
};
/** One immutable owner per session. Retried event IDs are unchanged, so uncertain writes are idempotent. */
export class UsageSession {
    private state: UsageLocalState = { version: 1, counts: {}, pending: [], dropped: {} };
    private active = true;
    private saving = Promise.resolve();
    private dirty = false;
    private writing = false;
    private running = false;
    private flushing: Promise<void> | null = null;
    private permanentFailure = false;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private retryMs = 2000;
    private abort = new AbortController();
    private storageUnavailable = false;
    private lastVisit = "";
    private loaded: Promise<void>;
    constructor(readonly owner: string, readonly enterprise: boolean, private deps: UsageSessionDependencies) {
        this.loaded = deps.read().then(value => {
            if (value?.version === 1 && value.counts && Array.isArray(value.pending) && value.dropped) this.state = value;
        }).catch(() => { this.storageUnavailable = true; }).then(() => { if (this.active) { this.publish(); this.schedule(); } });
    }
    private publish() { this.deps.changed({ ...this.state.counts }, this.storageUnavailable); }
    private persist() {
        this.dirty = true;
        if (this.writing) return;
        this.writing = true;
        // Coalesce storage snapshots, not events. A burst still retains every queued event or an explicit gap.
        this.saving = Promise.resolve().then(async () => {
            while (this.dirty) {
                this.dirty = false;
                try { await this.deps.write(structuredClone(this.state)); }
                catch { this.storageUnavailable = true; if (this.active) this.publish(); }
            }
        }).finally(() => { this.writing = false; if (this.dirty) this.persist(); });
    }
    async record(event: UsageClientEvent, visitToken?: string) {
        await this.loaded;
        if (!this.active) return;
        if (event.action === "visit") {
            if (visitToken && visitToken === this.lastVisit) return;
            this.lastVisit = visitToken || event.eventId;
            this.state.counts[event.boardKey] = (this.state.counts[event.boardKey] || 0) + 1;
        }
        if (this.enterprise) {
            if (this.state.pending.length < (this.deps.maxPending ?? 2000)) this.state.pending.push(event);
            else this.state.dropped[event.boardKey] = (this.state.dropped[event.boardKey] || 0) + 1;
        }
        this.persist(); this.publish(); this.schedule();
    }
    private schedule() {
        if (!this.active || !this.enterprise || this.timer || this.running || this.permanentFailure) return;
        this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.retryMs);
    }
    flush(): Promise<void> {
        if (this.flushing) return this.flushing;
        const pending = this.performFlush(); this.flushing = pending;
        void pending.finally(() => { if (this.flushing === pending) this.flushing = null; });
        return pending;
    }
    private async performFlush() {
        await this.loaded;
        if (!this.active || !this.enterprise || this.running) return;
        if (this.timer) clearTimeout(this.timer); this.timer = undefined;
        this.running = true;
        try {
            // No event sampling: every captured interaction is queued; capacity loss becomes an explicit gap.
            while (this.active) {
                const now = Date.parse(this.deps.now?.() ?? new Date().toISOString());
                this.state.pending = this.state.pending.filter(event => {
                    const age = now - Date.parse(event.occurredAt);
                    if (Number.isFinite(age) && age <= USAGE_MAX_EVENT_AGE_MS && age >= -USAGE_MAX_EVENT_FUTURE_MS) return true;
                    this.state.dropped[event.boardKey] = (this.state.dropped[event.boardKey] || 0) + (event.action === "gap" ? event.parameters?.droppedEventCount || 1 : 1);
                    return false;
                });
                if (this.state.pending.length < 50) {
                    for (const [boardKey, count] of Object.entries(this.state.dropped)) {
                        if (!count || this.state.pending.length >= 50) continue;
                        const reported = Math.min(count, 100000);
                        this.state.pending.push({ eventId: this.deps.id?.() ?? createClientUuid(), occurredAt: this.deps.now?.() ?? new Date().toISOString(), boardKey, action: "gap", controlKey: "collection-gap", parameters: { droppedEventCount: reported } });
                        if (count > reported) this.state.dropped[boardKey] = count - reported; else delete this.state.dropped[boardKey];
                    }
                    this.persist();
                }
                const batch = this.state.pending.slice(0, 50);
                if (!batch.length) break;
                let result: UsageEventsResult;
                try { result = await this.deps.post(batch, this.abort.signal); }
                catch (error) {
                    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
                    if (this.active && [400, 413, 422].includes(status)) {
                        // Invalid client records cannot hold every later event hostage.
                        // A rejected gap means a contract mismatch: stop automatic retries for this page lifetime.
                        if (batch.every(event => event.action === "gap")) { this.permanentFailure = true; throw error; }
                        const rejected = new Set(batch.map(event => event.eventId));
                        this.state.pending = this.state.pending.filter(event => !rejected.has(event.eventId));
                        for (const event of batch) this.state.dropped[event.boardKey] = (this.state.dropped[event.boardKey] || 0) + (event.action === "gap" ? event.parameters?.droppedEventCount || 1 : 1);
                        this.persist(); continue;
                    }
                    if ([404, 405, 501].includes(status)) this.permanentFailure = true;
                    throw error;
                }
                if (!this.active) return;
                if (result.accepted + result.duplicates !== batch.length) throw new Error("Incomplete usage acknowledgement");
                const ids = new Set(batch.map(event => event.eventId));
                this.state.pending = this.state.pending.filter(event => !ids.has(event.eventId));
                this.persist();
            }
            if (!this.active) return;
            const remote = await this.deps.me(this.abort.signal);
            if (!this.active) return;
            // Events recorded while GET was in flight are not yet present in its snapshot.
            const pendingVisits: Record<string, number> = {};
            for (const event of this.state.pending) if (event.action === "visit") pendingVisits[event.boardKey] = (pendingVisits[event.boardKey] || 0) + 1;
            for (const board of remote.boards) this.state.counts[board.key] = Math.max(this.state.counts[board.key] || 0, board.count + (pendingVisits[board.key] || 0));
            this.retryMs = 2000; this.persist(); this.publish();
        } catch {
            // Analytics must never block a design action. Keep original IDs for retry after connectivity recovers.
            this.retryMs = Math.min(this.retryMs * 2, 60000);
        } finally {
            this.running = false;
            if (this.active && (this.state.pending.length || Object.keys(this.state.dropped).length)) this.schedule();
        }
    }
    dispose() { this.active = false; this.abort.abort(); if (this.timer) clearTimeout(this.timer); }
    async settled() { await this.loaded; do { await this.saving; } while (this.writing || this.dirty); }
}
