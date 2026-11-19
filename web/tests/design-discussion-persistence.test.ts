import { describe, expect, test } from "bun:test";
import { createDesignSessionPersistence } from "../src/components/canvas/design-discussion/session-persistence.mjs";

function storage() {
    const values = new Map<string, unknown>();
    const writes: Array<{ key: string; value: unknown }> = [];
    return {
        values, writes,
        getItem: async (key: string) => values.get(key) ?? null,
        async setItem(key: string, value: unknown) { writes.push({ key, value }); values.set(key, structuredClone(value)); },
    };
}
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
const draft = { id: "session", prompt: "初稿", history: [], references: [{ id: "image", image: dataUrl }], documents: [{ id: "document", figures: [{ id: "figure", dataUrl }] }] };

describe("discussion draft durability", () => {
    test("a slow write keeps only the latest queued draft and stores shared original bytes once", async () => {
        const sessions = storage(), media = storage(), gate = deferred();
        const persistence = createDesignSessionPersistence({ ...sessions, async setItem(key: string, value: unknown) { if (!sessions.writes.length) await gate.promise; await sessions.setItem(key, value); } }, media, () => {}, 60_000);
        persistence.schedule(draft);
        const pending = persistence.flush();
        await Promise.resolve();
        for (let index = 0; index < 50; index++) persistence.schedule({ ...draft, prompt: `草稿 ${index}` });
        gate.resolve();
        await pending;
        expect(sessions.writes).toHaveLength(2);
        expect(media.writes).toHaveLength(1);
        expect(media.writes[0].value).toBe(dataUrl);
        expect(JSON.stringify(sessions.writes)).not.toContain(dataUrl);
        const restored = createDesignSessionPersistence(sessions, media, () => {});
        expect(await restored.load()).toEqual({ ...draft, prompt: "草稿 49" });
        restored.schedule({ ...draft, prompt: "继续讨论" });
        await restored.flush();
        expect(media.writes).toHaveLength(1);
        await persistence.dispose(); await restored.dispose();
    });

    test("media storage failure cannot overwrite the saved session and the latest draft can retry", async () => {
        const sessions = storage(), media = storage();
        sessions.values.set("session", { id: "previous", prompt: "原会话" });
        let reject = true;
        const persistence = createDesignSessionPersistence(sessions, { ...media, async setItem(key: string, value: unknown) { if (reject) throw new Error("quota"); await media.setItem(key, value); } }, () => {}, 60_000);
        persistence.schedule(draft);
        await expect(persistence.flush()).rejects.toThrow("quota");
        expect(sessions.values.get("session")).toEqual({ id: "previous", prompt: "原会话" });
        persistence.schedule({ ...draft, prompt: "失败后最新草稿" });
        reject = false;
        await persistence.flush();
        expect(await persistence.load()).toEqual({ ...draft, prompt: "失败后最新草稿" });
        expect(sessions.values.get("session")).toEqual({ id: "previous", prompt: "原会话" });
        expect(media.writes).toHaveLength(1);
        await persistence.dispose();
    });

    test("legacy inline data is read unchanged and missing referenced bytes are never silently discarded", async () => {
        const sessions = storage(), media = storage();
        sessions.values.set("session", draft);
        const persistence = createDesignSessionPersistence(sessions, media, () => {}, 60_000);
        expect(await persistence.load()).toEqual(draft);
        expect(sessions.writes).toHaveLength(0);
        persistence.schedule(draft); await persistence.flush();
        expect(sessions.values.get("session")).toEqual(draft);
        expect(sessions.writes[0].key).toBe("session:media-v1");
        media.values.clear();
        const otherOwner = createDesignSessionPersistence(sessions, storage(), () => {});
        await expect(otherOwner.load()).rejects.toThrow("未覆盖原会话");
        expect(sessions.writes).toHaveLength(1);
        await persistence.dispose(); await otherOwner.dispose();
    });

    test("a newer draft wins while the original snapshot remains unchanged for an old client", async () => {
        const sessions = storage(), media = storage();
        sessions.values.set("session", structuredClone(draft));
        const persistence = createDesignSessionPersistence(sessions, media, () => {}, 60_000);
        expect(await persistence.load()).toEqual(draft);
        persistence.schedule({ ...draft, prompt: "新版修改" }); await persistence.flush();
        const reopened = createDesignSessionPersistence(sessions, media, () => {});
        expect(await reopened.load()).toEqual({ ...draft, prompt: "新版修改" });
        expect(sessions.values.get("session")).toEqual(draft);
        expect(sessions.writes.every(write => write.key === "session:media-v1")).toBe(true);
        await persistence.dispose(); await reopened.dispose();
    });

    test.each([{}, false, { ...draft, history: null }, { ...draft, references: [{ image: { designDiscussionMedia: 123 } }] }])("a damaged new-format record is an error, not permission to load the older snapshot: %j", async damaged => {
        const sessions = storage(), media = storage();
        sessions.values.set("session", structuredClone(draft));
        sessions.values.set("session:media-v1", damaged);
        const persistence = createDesignSessionPersistence(sessions, media, () => {});
        await expect(persistence.load()).rejects.toThrow("原会话");
        expect(sessions.values.get("session")).toEqual(draft);
        expect(sessions.writes).toHaveLength(0);
        await persistence.dispose();
    });

    test("disposing flushes the last draft immediately and rejects later schedules", async () => {
        const sessions = storage(), media = storage();
        const persistence = createDesignSessionPersistence(sessions, media, () => {}, 60_000);
        persistence.schedule({ ...draft, prompt: "离开前草稿" });
        await persistence.dispose();
        persistence.schedule({ ...draft, prompt: "迟到的旧画布回调" });
        await persistence.flush();
        expect(sessions.writes).toHaveLength(1);
        expect(await persistence.load()).toEqual({ ...draft, prompt: "离开前草稿" });
    });
});
