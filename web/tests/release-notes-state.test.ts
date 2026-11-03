import { describe, expect, test } from "bun:test";
import { createReleaseNotesStore, releaseNoteSummary, releaseVersion } from "../src/lib/release-notes-state";
import type { PublicReleaseNote, ReleaseNotesPage } from "../../shared/release-notes";

const note = (version = "v0.5.19"): PublicReleaseNote => ({ version, title: "更新标题", content: "第一项\n第二项", publishedAt: "2026-11-03T12:00:00.000Z" });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function setup() {
    let owner: string | null = "employee-a", time = 100_000;
    const seen = new Map<string, { readVersion?: string; notifiedVersion?: string }>();
    const calls: number[] = [];
    let handler = async (_offset: number): Promise<ReleaseNotesPage<PublicReleaseNote>> => ({ notes: [note()], hasMore: false });
    const store = createReleaseNotesStore({
        list: (offset, _signal) => { calls.push(offset); return handler(offset); },
        readSeen: async id => seen.get(id) || null,
        writeSeen: async (id, value) => { seen.set(id, value); },
        isCurrentOwner: id => id === owner,
        now: () => time,
    });
    return { store, calls, seen, owner: (id: string | null) => { owner = id; }, advance: (ms: number) => { time += ms; }, handler: (fn: typeof handler) => { handler = fn; } };
}

describe("employee-scoped release announcements", () => {
    test("first load gives one notice, reading persists by employee and does not open automatically", async () => {
        const env = setup(); await env.store.getState().setOwner("employee-a");
        expect(env.store.getState().open).toBe(false);
        expect(env.store.getState().claimNotice()?.version).toBe("v0.5.19");
        expect(env.store.getState().claimNotice()).toBeNull();
        env.store.getState().show();
        expect(env.seen.get("employee-a")?.readVersion).toBe("v0.5.19");
        env.store.getState().close();
        env.owner("employee-b"); await env.store.getState().setOwner("employee-b");
        expect(env.store.getState().seen.readVersion).toBeUndefined();
        expect(env.store.getState().claimNotice()?.version).toBe("v0.5.19");
        env.owner("employee-a"); await env.store.getState().setOwner("employee-a");
        expect(env.store.getState().claimNotice()).toBeNull();
    });

    test("late old-identity response cannot repopulate notes or drawer", async () => {
        const env = setup(), response = deferred<ReleaseNotesPage<PublicReleaseNote>>();
        env.handler(() => response.promise);
        const initial = env.store.getState().setOwner("employee-a");
        await Promise.resolve();
        env.owner(null); await env.store.getState().setOwner(null);
        response.resolve({ notes: [note()], hasMore: false }); await initial;
        expect(env.store.getState().notes).toEqual([]);
        expect(env.store.getState().claimNotice()).toBeNull();
        env.store.getState().show(); expect(env.store.getState().open).toBe(false);
    });

    test("auth expiration fences completion even before lifecycle cleanup", async () => {
        const env = setup(), response = deferred<ReleaseNotesPage<PublicReleaseNote>>();
        env.handler(() => response.promise);
        const initial = env.store.getState().setOwner("employee-a"); await Promise.resolve();
        env.owner(null); response.resolve({ notes: [note()], hasMore: false }); await initial;
        expect(env.store.getState().notes).toEqual([]);
    });

    test("late storage read for previous employee cannot overwrite new employee state", async () => {
        const first = deferred<{ readVersion: string } | null>();
        let owner = "a";
        const store = createReleaseNotesStore({ list: async () => ({ notes: [note()], hasMore: false }), readSeen: id => id === "a" ? first.promise : Promise.resolve(null), writeSeen: async () => {}, isCurrentOwner: id => id === owner });
        const old = store.getState().setOwner("a"); owner = "b"; await store.getState().setOwner("b");
        first.resolve({ readVersion: "v0.5.19" }); await old;
        expect(store.getState().ownerId).toBe("b"); expect(store.getState().seen.readVersion).toBeUndefined();
    });

    test("background refresh is deduplicated, throttled, and a new publication is noticed once", async () => {
        const env = setup(); await env.store.getState().setOwner("employee-a");
        env.store.getState().claimNotice();
        await env.store.getState().refresh(); expect(env.calls).toEqual([0]);
        env.advance(120_000); env.handler(async () => ({ notes: [note("v0.5.20"), note()], hasMore: false }));
        await Promise.all([env.store.getState().refresh(), env.store.getState().refresh()]);
        expect(env.calls).toEqual([0, 0]); expect(env.store.getState().claimNotice()?.version).toBe("v0.5.20");
        expect(env.store.getState().claimNotice()).toBeNull(); expect(env.store.getState().open).toBe(false);
    });

    test("transient error keeps previous published content and never throws into creative UI", async () => {
        const env = setup(); await env.store.getState().setOwner("employee-a");
        env.handler(async () => { throw Object.assign(new Error("offline"), { status: 503 }); });
        await env.store.getState().refresh(true);
        expect(env.store.getState().notes).toHaveLength(1); expect(env.store.getState().error).toContain("不影响继续创作");
        expect(env.store.getState().loading).toBe(false);
    });

    test("missing formal module disables future requests for this identity session", async () => {
        const env = setup(); env.handler(async () => { throw Object.assign(new Error("absent"), { status: 404 }); });
        await env.store.getState().setOwner("employee-a"); await env.store.getState().refresh(true);
        expect(env.calls).toEqual([0]); expect(env.store.getState().supported).toBe(false); expect(env.store.getState().notes).toEqual([]);
    });

    test("pagination preserves latest and reading older history does not reset latest read state", async () => {
        const env = setup(); env.handler(async offset => ({ notes: offset ? [note(), note("v0.5.18")] : [note()], hasMore: offset === 0 }));
        await env.store.getState().setOwner("employee-a"); env.store.getState().show();
        await env.store.getState().refresh(true, true); env.store.getState().show("v0.5.18");
        expect(env.calls).toEqual([0, 1]); expect(env.store.getState().notes.map(item => item.version)).toEqual(["v0.5.19", "v0.5.18"]);
        expect(env.store.getState().seen.readVersion).toBe("v0.5.19");
    });
    test("version and summary are presentation-only plain text", () => {
        expect(releaseVersion("0.5.19\n")).toBe("v0.5.19"); expect(releaseVersion("v0.5.19")).toBe("v0.5.19");
        expect(releaseNoteSummary(" a\n b ")).toBe("a b"); expect(releaseNoteSummary("a".repeat(140))).toHaveLength(121);
        expect(releaseNoteSummary("<script>literal</script>")).toBe("<script>literal</script>");
    });
    test("hidden pages do not make read requests until visible again", async () => {
        let visible = false, reads = 0;
        const store = createReleaseNotesStore({ list: async () => { reads++; return { notes: [note()], hasMore: false }; }, readSeen: async () => null, writeSeen: async () => {}, isCurrentOwner: id => id === "a", isVisible: () => visible });
        await store.getState().setOwner("a"); expect(reads).toBe(0);
        visible = true; await store.getState().refresh(); expect(reads).toBe(1);
    });
});
