import { describe, expect, test } from "bun:test";
import { UsageSession, type UsageLocalState, type UsageSessionDependencies } from "../src/lib/usage-session";
import type { UsageClientEvent, UsageMeResult } from "../../shared/usage-analytics";

const now = "2026-10-15T10:00:00.000Z";
const event = (boardKey = "image", action: UsageClientEvent["action"] = "click"): UsageClientEvent => ({ eventId: crypto.randomUUID(), occurredAt: now, boardKey, action, ...(action === "visit" ? {} : { controlKey: "settings" }) });
const me = (count = 0): UsageMeResult => ({ boards: [{ key: "image", label: "文生图", count }], controls: [], coverage: { collectionStartedAt: now, historicalTasksAvailable: true, historicalClicksAvailable: false, historicalChatAvailable: false, notes: [] } });
function fixture(overrides: Partial<UsageSessionDependencies> = {}) {
    let stored: UsageLocalState | null = null;
    const posted: UsageClientEvent[][] = [], snapshots: Record<string, number>[] = [];
    const deps: UsageSessionDependencies = { read: async () => stored, write: async value => { stored = structuredClone(value); }, post: async events => { posted.push(structuredClone(events)); return { accepted: events.length, duplicates: 0 }; }, me: async () => me(), changed: counts => snapshots.push(counts), now: () => now, ...overrides };
    return { deps, posted, snapshots, get stored() { return stored; } };
}
describe("personal usage session", () => {
    test("StrictMode/re-render does not repeat one entry; leaving and returning does count", async () => {
        const f = fixture(), session = new UsageSession("a", false, f.deps);
        await session.record(event("image", "visit"), "route-one"); await session.record(event("image", "visit"), "route-one");
        await session.record(event("video", "visit"), "route-two"); await session.record(event("image", "visit"), "route-one"); await session.settled();
        expect(f.stored?.counts).toEqual({ image: 2, video: 1 }); expect(f.stored?.pending).toEqual([]); await session.flush(); expect(f.posted).toHaveLength(0); session.dispose();
    });
    test("batches all 121 events in order, at most 50; server refresh is not added twice", async () => {
        const f = fixture({ me: async () => me(20) }), session = new UsageSession("a", true, f.deps);
        for (let i = 0; i < 121; i++) await session.record(event("image", i < 2 ? "visit" : "click"));
        await session.flush(); await session.settled(); expect(f.posted.map(batch => batch.length)).toEqual([50, 50, 21]); expect(f.stored?.counts.image).toBe(20);
        await session.flush(); expect(f.stored?.counts.image).toBe(20); expect(f.stored?.pending).toEqual([]); session.dispose();
    });
    test("offline retries preserve UUIDs, accepts duplicate acknowledgement", async () => {
        let fail = true; const batches: UsageClientEvent[][] = [];
        const f = fixture({ post: async batch => { batches.push(structuredClone(batch)); if (fail) throw new Error("offline"); return { accepted: 0, duplicates: batch.length }; } });
        const session = new UsageSession("a", true, f.deps), original = event(); await session.record(original); await session.flush(); await session.settled(); expect(f.stored?.pending).toHaveLength(1);
        fail = false; await session.flush(); await session.settled(); expect(batches[0][0].eventId).toBe(batches[1][0].eventId); expect(f.stored?.pending).toEqual([]); session.dispose();
    });
    test("capacity overflow is explicit gap, never silent sampling", async () => {
        const f = fixture({ maxPending: 3 }), session = new UsageSession("a", true, f.deps);
        for (let i = 0; i < 8; i++) await session.record(event()); await session.flush(); await session.settled();
        const all = f.posted.flat(); expect(all.filter(item => item.action === "click")).toHaveLength(3);
        expect(all.find(item => item.action === "gap")?.parameters).toEqual({ droppedEventCount: 5 }); expect(f.stored?.dropped).toEqual({}); session.dispose();
    });
    test("older than seven days and future events become one current gap; healthy new event progresses", async () => {
        const old = event(), future = event(); old.occurredAt = "2026-10-01T10:00:00Z"; future.occurredAt = "2026-10-15T10:10:00Z";
        const f = fixture({ read: async () => ({ version: 1, counts: {}, pending: [old, future], dropped: {} }) });
        const session = new UsageSession("a", true, f.deps); await session.record(event()); await session.flush();
        expect(f.posted.flat().map(item => item.action)).toEqual(["click", "gap"]); expect(f.posted.flat()[1].occurredAt).toBe(now); expect(f.posted.flat()[1].parameters?.droppedEventCount).toBe(2); session.dispose();
    });
    test("permanent 400 becomes gap instead of retrying a poisoned batch forever", async () => {
        const sent: UsageClientEvent[][] = [];
        const f = fixture({ post: async batch => { sent.push(structuredClone(batch)); if (sent.length === 1) throw { status: 400 }; return { accepted: batch.length, duplicates: 0 }; } });
        const session = new UsageSession("a", true, f.deps); await session.record(event()); await session.flush();
        expect(sent).toHaveLength(2); expect(sent[1][0].action).toBe("gap"); expect(sent[1][0].parameters?.droppedEventCount).toBe(1); session.dispose();
    });
    test("identity disposal aborts in flight and cannot remove old-account records from uncertain writes", async () => {
        let complete!: (value: { accepted: number; duplicates: number }) => void, signal!: AbortSignal;
        const f = fixture({ post: async (_batch, current) => { signal = current; return new Promise(resolve => { complete = resolve; }); } });
        const session = new UsageSession("a", true, f.deps); await session.record(event()); const flushing = session.flush(); await Promise.resolve(); await Promise.resolve(); session.dispose();
        expect(signal.aborted).toBe(true); complete({ accepted: 1, duplicates: 0 }); await flushing; await session.settled(); expect(f.stored?.pending).toHaveLength(1);
    });
    test("late account-A hydration is ignored after disposal while B gets only its own counts", async () => {
        let resolveA!: (value: UsageLocalState) => void;
        const a = fixture({ read: () => new Promise(resolve => { resolveA = resolve; }) }), b = fixture();
        const first = new UsageSession("a", false, a.deps), second = new UsageSession("b", false, b.deps); first.dispose();
        resolveA({ version: 1, counts: { image: 999 }, pending: [], dropped: {} }); await second.record(event("video", "visit"), "b-route"); await first.settled(); await second.settled();
        expect(a.snapshots).toEqual([]); expect(b.stored?.counts).toEqual({ video: 1 }); second.dispose();
    });
    test("storage failures remain nonblocking and visible", async () => {
        const statuses: boolean[] = [];
        const f = fixture({ read: async () => { throw new Error("storage denied"); }, write: async () => { throw new Error("quota"); }, changed: (_counts, unavailable) => statuses.push(unavailable) });
        const session = new UsageSession("a", true, f.deps); await session.record(event()); await session.flush(); await session.settled(); expect(f.posted.flat()).toHaveLength(1); expect(statuses.every(Boolean)).toBe(true); session.dispose();
    });
});
