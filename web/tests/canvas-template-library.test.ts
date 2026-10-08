import { expect, test } from "bun:test";
import { createCanvasTemplateLibrary } from "../src/lib/canvas/canvas-template-library";
import { canvasDesignTemplates, createCanvasDesignTemplate } from "../src/lib/canvas/canvas-design-templates";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function memory() {
    const values = new Map<string, unknown>();
    return {
        values,
        async getItem<T>(key: string) { return structuredClone(values.get(key) ?? null) as T | null; },
        async setItem<T>(key: string, value: T) { values.set(key, structuredClone(value)); return value; },
        async iterate<T, U>(callback: (value: T, key: string, iteration: number) => U) { let index = 0; for (const [key, value] of values) callback(structuredClone(value) as T, key, ++index); return undefined as U; },
    };
}
const draft = () => ({ baseTemplateId: "development" as const, title: "我的改款流程", steps: [["自定义线稿", "保留衣领，绘制背面线稿\n不要文字"], ["定制配色", "主体改为酒红色"], ["模特", "正面全身摄影"]] as const });

test("personal template survives a fresh reader, updates the same id, and copies without changing built-ins", async () => {
    const store = memory(), builtin = JSON.stringify(canvasDesignTemplates);
    const library = createCanvasTemplateLibrary(store, "a", () => "a");
    const original = await library.save(draft());
    expect(await createCanvasTemplateLibrary(store, "a", () => "a").list()).toEqual([original]);
    const updated = await library.save({ ...draft(), id: original.id, title: "更新后的流程" });
    expect(updated.id).toBe(original.id);
    expect(updated.createdAt).toBe(original.createdAt);
    expect(await library.list()).toEqual([updated]);
    const copy = await library.save({ ...draft(), title: "另一套流程" });
    expect(copy.id).not.toBe(updated.id);
    expect(await library.list()).toHaveLength(2);
    expect(JSON.stringify(canvasDesignTemplates)).toBe(builtin);
});

test("reuse retains edited title/prompts but binds a new current reference and never mutates existing nodes", async () => {
    const saved = await createCanvasTemplateLibrary(memory(), "a", () => "a").save(draft());
    const source: CanvasNodeData = { id: "new-reference", type: CanvasNodeType.Image, title: "新款", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { storageKey: "new-image" } };
    const before = structuredClone(source);
    const result = createCanvasDesignTemplate(saved.baseTemplateId, source, { x: 300, y: 0 }, "model", undefined, saved.steps, saved.title);
    expect(result.group.title).toBe(saved.title);
    result.nodes.forEach((node, index) => {
        expect(node.title).toBe(saved.steps[index][0]);
        expect(node.metadata?.prompt).toBe(saved.steps[index][1]);
        expect(node.metadata?.composerContent).toBe(`参考款：@[node:new-reference]\n${saved.steps[index][1]}`);
        expect(node.metadata?.status).toBe("idle");
    });
    expect(source).toEqual(before);
    expect(result.connections.every(connection => connection.fromNodeId === source.id)).toBe(true);
});

test("different owners are isolated even when they share the same local store", async () => {
    const store = memory();
    await createCanvasTemplateLibrary(store, "a", () => "a").save(draft());
    expect(await createCanvasTemplateLibrary(store, "b", () => "b").list()).toEqual([]);
    let owner = "a";
    const library = createCanvasTemplateLibrary(store, owner, () => owner);
    owner = "b";
    await expect(library.save(draft())).rejects.toThrow("身份已变化");
    await expect(library.list()).rejects.toThrow("身份已变化");
    expect(store.values.size).toBe(1);
});

test("quota failure preserves previous data and edit input; retry succeeds", async () => {
    const store = memory();
    const library = createCanvasTemplateLibrary(store, "a", () => "a");
    const saved = await library.save(draft());
    const input = { ...draft(), id: saved.id, title: "未保存修改" };
    const snapshot = structuredClone(input);
    const failing = createCanvasTemplateLibrary({ ...store, async setItem<T>(_key: string, _value: T): Promise<T> { throw new Error("quota exceeded"); } }, "a", () => "a");
    await expect(failing.save(input)).rejects.toThrow("quota exceeded");
    expect(await library.list()).toEqual([saved]);
    expect(input).toEqual(snapshot);
    await library.save(input);
    expect((await library.list())[0].title).toBe(input.title);
});

test("invalid or damaged templates fail closed and do not erase saved data", async () => {
    const store = memory(), library = createCanvasTemplateLibrary(store, "a", () => "a");
    for (const input of [{ ...draft(), title: " " }, { ...draft(), title: "x".repeat(81) }, { ...draft(), steps: [] }, { ...draft(), steps: [["one", ""], ["two", "ok"], ["three", "ok"]] }]) await expect(library.save(input)).rejects.toThrow();
    const saved = await library.save(draft());
    const key = `owner:a:template:${saved.id}`;
    store.values.set(key, { ...saved, version: 99 });
    await expect(library.list()).rejects.toThrow("格式无效");
    await expect(library.save({ ...draft(), id: saved.id })).rejects.toThrow("格式无效");
    expect(store.values.get(key)).toEqual({ ...saved, version: 99 });
});

test("identity change during async read prevents an update under another employee", async () => {
    const store = memory();
    const saved = await createCanvasTemplateLibrary(store, "a", () => "a").save(draft());
    let owner = "a";
    const library = createCanvasTemplateLibrary({ ...store, async getItem<T>(key: string) { const result = await store.getItem<T>(key); owner = "b"; return result; } }, "a", () => owner);
    await expect(library.save({ ...draft(), id: saved.id, title: "must not save" })).rejects.toThrow("身份已变化");
    expect(await createCanvasTemplateLibrary(store, "a", () => "a").list()).toEqual([saved]);
});
