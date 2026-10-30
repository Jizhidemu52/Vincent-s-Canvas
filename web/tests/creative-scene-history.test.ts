import { expect, test } from "bun:test";
import { createSceneHistory } from "../src/pages/creative/scene-history";
import { createSceneForm } from "../src/pages/creative/scene-form-model";
import type { SceneLog } from "../src/pages/creative/use-scene-workspace";

function log(id: string, createdAt: number): SceneLog {
    return { id, ownerId: "owner", sceneId: "text-to-style", createdAt, prompt: "原始提示词", form: createSceneForm("text-to-style"), config: { model: "m", imageModel: "m", count: "1", quality: "auto", size: "auto" }, referenceImages: {}, results: [], images: [], durationMs: 1, successCount: 0, failCount: 0 };
}
function fixture() {
    const values = new Map<string, unknown>();
    const reads: string[] = [], writes: string[] = [];
    const storage = {
        async getItem<T>(key: string): Promise<T | null> { reads.push(key); return structuredClone(values.get(key) ?? null) as T | null; },
        async setItem<T>(key: string, value: T) { writes.push(key); values.set(key, structuredClone(value)); return value; },
    };
    return { values, reads, writes, storage, history: createSceneHistory(storage, "owner", "text-to-style") };
}
test("legacy history is preserved, indexed once, and paged without reading image-bearing records", async () => {
    const f = fixture(), old = Array.from({ length: 45 }, (_, index) => log(`old-${index}`, index));
    f.values.set("history:owner:text-to-style", old);
    const first = await f.history.page();
    expect(first.entries).toHaveLength(20); expect(first.total).toBe(45); expect(first.hasMore).toBe(true);
    expect(first.entries[0]?.id).toBe("old-44");
    expect(f.values.get("history:owner:text-to-style")).toEqual(old);
    expect(JSON.stringify(first)).not.toContain("原始提示词");
    f.reads.length = 0; f.writes.length = 0;
    const second = await f.history.page(20);
    expect(second.entries).toHaveLength(20);
    expect(f.reads).toEqual(["history-index:owner:text-to-style"]); expect(f.writes).toEqual([]);
    expect((await f.history.read("old-44")).prompt).toBe("原始提示词");
    expect(f.reads.at(-1)).toBe("history-record:owner:text-to-style:old-44");
});
test("new results write only their detail and lightweight index, never rewrite prior media", async () => {
    const f = fixture(); await f.history.page();
    await f.history.save(log("first", 1)); f.reads.length = 0; f.writes.length = 0;
    await f.history.save(log("second", 2));
    expect(f.reads).toEqual(["history-index:owner:text-to-style"]);
    expect(f.writes).toEqual(["history-record:owner:text-to-style:second", "history-index:owner:text-to-style"]);
    expect((await f.history.page()).entries.map(item => item.id)).toEqual(["second", "first"]);
});
test("concurrent records are serialized without dropping a history entry", async () => {
    const f = fixture(); await f.history.page();
    await Promise.all(Array.from({ length: 12 }, (_, index) => f.history.save(log(String(index), index))));
    expect((await f.history.page()).total).toBe(12);
});
test("history access remains scoped by both owner and scene", async () => {
    const f = fixture(); await f.history.page();
    await expect(f.history.save({ ...log("other", 1), ownerId: "another" })).rejects.toThrow("其他账号");
    f.values.set("history-record:owner:text-to-style:other", { ...log("other", 1), sceneId: "local-restyle" });
    await expect(f.history.read("other")).rejects.toThrow("当前场景");
});

test("removing finished history preserves original records and media needed by later retries", async () => {
    const f = fixture();
    const done = { ...log("finished", 1), results: [{ id: "result", status: "success" as const }] };
    await f.history.save(done);
    await f.history.remove(done.id);
    expect((await f.history.page()).total).toBe(0);
    expect(await f.history.read(done.id)).toEqual(done);
    expect((await f.history.pending())).toEqual([]);
});

test.each(["pending", "uncertain", "legacy"])("%s scene records cannot lose task tracking through history removal", async state => {
    const f = fixture();
    const tracked: SceneLog = { ...log("tracked", 1), results: [{ id: "result", status: state === "pending" ? "pending" : "failed", ...(state === "uncertain" ? { failureKind: "uncertain" as const } : {}) }] };
    await f.history.save(tracked);
    await expect(f.history.remove(tracked.id)).rejects.toThrow("尚未明确结束");
    expect((await f.history.page()).total).toBe(1);
    expect(await f.history.read(tracked.id)).toEqual(tracked);
});
