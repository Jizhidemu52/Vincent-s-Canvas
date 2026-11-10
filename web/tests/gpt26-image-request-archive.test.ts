import { afterEach, beforeEach, expect, test } from "bun:test";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { restoreGenerationDraft } from "@/services/api/generation-history";
import { imageMarkupReference } from "@/lib/image-advanced-settings";
import { buildDirectImagePrompt } from "@/lib/image-reference-prompt";
import { defaultConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useUserStore } from "@/stores/use-user-store";

const originalFetch = globalThis.fetch;
const globals = globalThis as unknown as Record<string, unknown>;
const originalWindow = globals.window, originalReader = globals.FileReader;
const originalUser = useUserStore.getState(), originalBusiness = useBusinessConfigStore.getState();
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const model = { id: "gpt26-model-uuid", modelId: "gpt26-model-uuid", name: "Image", imageParameterProfile: "quality-resolution-v2", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 };
const references = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `ref-${index}`, name: `${index}.png`, type: "image/png", dataUrl: png }));
const markup = { id: "markup", name: "overlay.png", type: "image/png", dataUrl: png };
const config = { ...defaultConfig, model: model.id, imageModel: model.id, size: "1:1", quality: "high", imageOptions: JSON.stringify({ complexity: "low", markup_reference: JSON.stringify(markup) }) };
let requests: Array<{ path: string; method: string; body?: any }>, assets: Map<string, Blob>, tasks: Map<string, any>;
let ownerSequence = 0;
beforeEach(() => {
    requests = []; assets = new Map(); tasks = new Map();
    const owner = `gpt26-archive-${++ownerSequence}`;
    useUserStore.setState({ user: { id: owner, status: "active", role: "designer" } as never, status: "authenticated" });
    useBusinessConfigStore.setState({ models: [], tools: [] });
    globals.window = { location: { pathname: "/canvas/gpt26-archive" } };
    globals.FileReader = class {
        result = ""; onload?: () => void;
        readAsDataURL(blob: Blob) { void blob.arrayBuffer().then(bytes => { this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`; this.onload?.(); }); }
    };
    globalThis.fetch = (async (url, init) => {
        const path = String(url), method = init?.method || "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        requests.push({ path, method, body });
        if (path === "/api/models") return Response.json({ models: [model], tools: [], prices: [] });
        if (path === "/api/auth/session") return Response.json({ user: { id: owner, status: "active", role: "designer" } });
        if (path === "/api/assets/upload-request") {
            const id = `source-${assets.size}`; assets.set(id, new Blob());
            return Response.json({ assetId: id, uploadUrl: `/upload/${id}` });
        }
        if (path.startsWith("/upload/")) { assets.set(path.split("/").pop()!, init!.body as Blob); return new Response(null, { status: 204 }); }
        if (path === "/api/tasks") {
            const id = `task-${tasks.size}`;
            const task = { ...body, id, userId: owner, status: "success", resultUrls: ["/api/assets/output/content"] };
            tasks.set(id, task); return Response.json({ task });
        }
        if (path.startsWith("/api/tasks/")) return Response.json({ task: tasks.get(path.split("/").pop()!) });
        if (/^\/api\/assets\/source-\d+$/.test(path)) return Response.json({ asset: { id: path.split("/").pop()!, ownerUserId: owner, kind: "image", status: "ready" } });
        if (method === "HEAD" && path.startsWith("/api/assets/")) return new Response(null, { headers: { "content-type": "image/png" } });
        if (path.startsWith("/api/assets/")) return new Response(assets.get(path.split("/")[3]!), { headers: { "content-type": "image/png" } });
        throw new Error(`Unexpected ${method} ${path}`);
    }) as typeof fetch;
});
afterEach(() => {
    globalThis.fetch = originalFetch; globals.window = originalWindow; globals.FileReader = originalReader;
    useUserStore.setState(originalUser); useBusinessConfigStore.setState(originalBusiness);
});

test("sixteen image references plus separate markup archive once, restore original bytes and resubmit without ordinary-reference pollution", async () => {
    await requestGeneration(config, "Edit the product using overlay", { tool: "canvas-image" }, references(16));
    const task = tasks.get("task-0");
    expect(task.sourceUrls).toHaveLength(17);
    expect(task.parameters).toMatchObject({ complexity: "low", inputArchive: { markupReferenceIndex: 16 } });
    expect(task.parameters).not.toHaveProperty("markup_reference");
    expect(task.parameters).not.toHaveProperty("markup_url");
    expect(task.parameters.inputArchive.config.imageOptions).toBe('{"complexity":"low"}');
    expect(task.parameters.inputArchive.references[16].name).toBe("overlay.png");
    requests = [];
    const restored = await restoreGenerationDraft("task-0");
    expect(restored.references).toHaveLength(16);
    expect(imageMarkupReference(restored.config.imageOptions)?.dataUrl).toBe(png);
    expect(requests.every(request => request.method === "GET")).toBe(true);
    await requestGeneration({ ...defaultConfig, ...restored.config }, restored.prompt, { tool: "canvas-image" }, restored.references);
    expect(tasks.size).toBe(2);
    expect(tasks.get("task-1").sourceUrls).toHaveLength(17);
    expect(tasks.get("task-1").parameters.inputArchive.markupReferenceIndex).toBe(16);
    expect(tasks.get("task-1").parameters.inputArchive.config.imageOptions).not.toContain("base64");
});

test("edit path attaches markup separately and blocks mask conflicts before uploading", async () => {
    await requestEdit(config, "Edit", references(1), undefined, { tool: "canvas-edit" });
    expect(tasks.get("task-0").parameters.inputArchive.markupReferenceIndex).toBe(1);
    expect(tasks.get("task-0").sourceUrls).toHaveLength(2);
    requests = [];
    await expect(requestEdit(config, "Edit", references(1), references(1)[0], { tool: "canvas-mask-edit" })).rejects.toThrow("不能同时");
    expect(requests.map(request => request.path)).toEqual(["/api/models"]);
});

test.each(["generate", "edit"])("%s sends the preview text literally, archives roles and never numbers markup", async mode => {
    const refs = references(2).map((image, index) => ({ ...image, role: index ? "只参考此图的颜色。" : "以此图作为编辑原图。" }));
    const text = '\n只改蓝色；保留 6 颗纽扣与 "春日 快乐"。  ';
    const withSystem = { ...config, systemPrompt: "保留明确要求。" };
    if (mode === "generate") await requestGeneration(withSystem, text, { tool: "canvas-image" }, refs);
    else await requestEdit(withSystem, text, refs, undefined, { tool: "canvas-edit" });
    const task = tasks.get("task-0");
    expect(task.prompt).toBe(buildDirectImagePrompt(withSystem, text, refs));
    expect(task.prompt.endsWith(text)).toBe(true);
    expect(task.prompt).toContain("图片1：以此图作为编辑原图。\n图片2：只参考此图的颜色。");
    expect(task.prompt).not.toContain("图片3");
    expect(task.parameters.inputArchive.prompt).toBe(text);
    expect(task.parameters.inputArchive.references.map((image: any) => image.role)).toEqual([...refs.map(image => image.role), undefined]);
    expect(requests.some(request => request.path.startsWith("/api/prompt-compilations"))).toBe(false);
    const restored = await restoreGenerationDraft("task-0");
    expect(restored.references.map(image => image.role)).toEqual(refs.map(image => image.role));
});

test("mask remains separate from numbered references and invalid role metadata blocks restore", async () => {
    const refs = references(2).map((image, index) => ({ ...image, role: index ? "只参考此图的图案。" : "以此图作为编辑原图。" }));
    await requestEdit({ ...config, imageOptions: "{}" }, "保留其他区域。", refs, references(1)[0], { tool: "canvas-mask-edit" });
    const task = tasks.get("task-0");
    expect(task.sourceUrls).toHaveLength(3);
    expect(task.prompt).not.toContain("图片3");
    expect(task.parameters.inputArchive.maskReferenceIndex).toBe(2);
    task.parameters.inputArchive.references[0].role = { invalid: true };
    await expect(restoreGenerationDraft("task-0")).rejects.toThrow("归档不完整");
});

test("GIF is a single ordinary generation and never uploads forbidden image inputs", async () => {
    const gif = { ...config, size: "512x512", imageOptions: '{"output_format":"gif","frame_count":"16","frame_duration_ms":"120"}' };
    await requestGeneration(gif, "looping flag", { tool: "canvas-image" });
    expect(tasks.get("task-0").parameters).toMatchObject({ output_format: "gif", frame_count: 16, frame_duration_ms: 120, count: 1, n: 1 });
    expect(tasks.get("task-0").sourceUrls).toEqual([]);
    requests = [];
    await expect(requestGeneration(gif, "looping flag", { tool: "canvas-image" }, references(1))).rejects.toThrow("GIF");
    expect(requests.map(request => request.path)).toEqual(["/api/models"]);
});

test("corrupted markup indices or changed original bytes fail historical restore atomically", async () => {
    await requestGeneration(config, "Edit", { tool: "canvas-image" }, references(1));
    const archive = tasks.get("task-0").parameters.inputArchive;
    archive.markupReferenceIndex = 0;
    await expect(restoreGenerationDraft("task-0")).rejects.toThrow("索引无效");
    archive.markupReferenceIndex = 1;
    const id = tasks.get("task-0").sourceUrls[1].split("/")[3];
    assets.set(id, new Blob(["not original"], { type: "image/png" }));
    await expect(restoreGenerationDraft("task-0")).rejects.toThrow("不是历史原始字节");
});
