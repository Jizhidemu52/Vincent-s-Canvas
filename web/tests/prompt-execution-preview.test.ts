import { afterEach, beforeEach, expect, test } from "bun:test";
import { defaultConfig, useConfigStore } from "../src/stores/use-config-store";
import { useUserStore } from "../src/stores/use-user-store";
import { cancelPromptExecutionPreview, confirmPromptExecution, invalidatePromptExecutionContext, usePromptExecutionPreview } from "../src/stores/use-prompt-execution-preview";
import { confirmImageTaskPreview, promptPreviewReferences } from "../src/services/api/prompt-task-preview";

const originalFetch = globalThis.fetch;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const task = () => ({ requestId: "preview-request:0", projectId: "test", operationType: "inpaint", toolKey: "creative-garment-colorway", modelConfigId: "image-model",
    prompt: "只改衣身蓝色", promptInput: { scene: "garment-colorway" as const, userText: "只改衣身蓝色", mode: "edit" as const, fields: {}, referenceRoles: ["原图", "配色参考"] }, parameters: { quality: "high" }, sourceUrls: ["/api/assets/a/content", "/api/assets/b/content"] });
const options = { modelName: "模型A", references: [{ url: "/api/assets/a/content", name: "衣服.png", label: "图片1：原图" }] };
const result = (value = task()) => Response.json({ preview: { prompt: "图片1只改衣身为蓝色，其余不变。", promptInput: { ...value.promptInput, compilationId: "9b5ee971-497d-40e2-8f1a-2a6c1c0a9e07" }, summaryZh: "只改衣身颜色" } });
beforeEach(() => {
    useConfigStore.setState({ config: { ...defaultConfig, promptPreview: true } });
    useUserStore.setState({ user: { id: "employee-a", status: "active" } as never, status: "authenticated" });
});
afterEach(async () => { cancelPromptExecutionPreview(); globalThis.fetch = originalFetch; useConfigStore.setState({ config: defaultConfig }); await tick(); });

test("fixed preview makes one preparation call and reuses that compilation only after confirmation", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url, init) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return result(); }) as typeof fetch;
    const input = task();
    let completed = false;
    const pending = confirmImageTaskPreview(input, options).then(value => { completed = true; return value; });
    await tick();
    expect(completed).toBe(false); expect(calls).toHaveLength(1); expect(calls[0]!.url).toBe("/api/tasks/preview");
    expect(usePromptExecutionPreview.getState().pending).toMatchObject({ prompt: "图片1只改衣身为蓝色，其余不变。", modelName: "模型A" });
    const dialog = usePromptExecutionPreview.getState().pending!;
    dialog.finish(true); dialog.finish(true);
    const approved = await pending;
    expect(approved.promptInput.compilationId).toBe("9b5ee971-497d-40e2-8f1a-2a6c1c0a9e07");
    expect(approved.requestId).toBe(input.requestId); expect(approved.sourceUrls).toEqual(input.sourceUrls);
    expect(input.promptInput).not.toHaveProperty("compilationId"); expect(calls).toHaveLength(1);
});

test("cancel never returns an admissible task", async () => {
    globalThis.fetch = (async () => result()) as typeof fetch;
    const pending = confirmImageTaskPreview(task(), options);
    await tick(); cancelPromptExecutionPreview(); await expect(pending).rejects.toThrow("已取消");
});

test("preview default-off does no network work", async () => {
    useConfigStore.setState({ config: { ...defaultConfig, promptPreview: false } });
    globalThis.fetch = (async () => { throw new Error("must not fetch"); }) as typeof fetch;
    const input = task(); expect(await confirmImageTaskPreview(input, options)).toBe(input);
});

test("an uncertain planner response is never retried or followed by a task", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new TypeError("network unavailable"); }) as typeof fetch;
    await expect(confirmImageTaskPreview(task(), options)).rejects.toMatchObject({ name: "PromptCompilationUncertainError" });
    expect(calls).toBe(1); expect(usePromptExecutionPreview.getState().pending).toBeNull();
});

test.each(["owner", "expired", "model", "input"])("%s changes invalidate a pending execution snapshot", async kind => {
    globalThis.fetch = (async () => result()) as typeof fetch;
    const input = task(); const pending = confirmImageTaskPreview(input, options);
    await tick();
    const dialog = usePromptExecutionPreview.getState().pending!;
    if (kind === "owner") useUserStore.setState({ user: { id: "employee-b", status: "active" } as never });
    if (kind === "expired") useUserStore.setState({ status: "expired" });
    if (kind === "model") useConfigStore.getState().updateConfig("model", "new-model");
    if (kind === "input") input.promptInput.userText = "新要求";
    dialog.finish(true); await expect(pending).rejects.toMatchObject({ name: "PromptPreviewCancelledError" });
    expect(usePromptExecutionPreview.getState().pending).toBeNull();
});

test("late compilation cannot appear for a changed employee", async () => {
    let finish!: (value: Response) => void;
    globalThis.fetch = (() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
    const pending = confirmImageTaskPreview(task(), options);
    useUserStore.setState({ user: { id: "employee-b", status: "active" } as never }); finish(result());
    await expect(pending).rejects.toMatchObject({ name: "PromptPreviewCancelledError" }); expect(usePromptExecutionPreview.getState().pending).toBeNull();
});

test("abort dismisses the dialog and a second dialog cannot replace the first", async () => {
    const controller = new AbortController();
    const preview = { ...options, ownerId: "employee-a", requestId: "one", prompt: "执行文本" };
    const pending = confirmPromptExecution(preview, { signal: controller.signal, assertCurrent() {} });
    expect(() => confirmPromptExecution({ ...preview, requestId: "two" }, { assertCurrent() {} })).toThrow("当前生成前确认");
    expect(usePromptExecutionPreview.getState().pending?.requestId).toBe("one");
    controller.abort(); await expect(pending).rejects.toThrow("已取消"); expect(usePromptExecutionPreview.getState().pending).toBeNull();
});

test("navigation during compilation invalidates its late response even when returning to the same URL", async () => {
    let finish!: (value: Response) => void;
    globalThis.fetch = (() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
    const pending = confirmImageTaskPreview(task(), options);
    invalidatePromptExecutionContext(); finish(result());
    await expect(pending).rejects.toMatchObject({ name: "PromptPreviewCancelledError" });
    expect(usePromptExecutionPreview.getState().pending).toBeNull();
});

test("reference numbering excludes both independent masks and markup", () => {
    expect(promptPreviewReferences(["a", "mask", "b", "markup"], task().promptInput, ["衣服", "选区", "配色", "圈选"], 1, 3).map(item => item.label))
        .toEqual(["图片1：原图", "编辑蒙版（不参与图片编号）", "图片2：配色参考", "圈选标注（不参与图片编号）"]);
});
