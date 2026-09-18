import { afterEach, beforeEach, expect, test } from "bun:test";
import { fingerprintImage, generationDraftInput, restoreGenerationDraft } from "../src/services/api/generation-history";
import { requestQueuedImages } from "../src/services/api/generation-tasks";
import { useUserStore } from "../src/stores/use-user-store";
import { restoreLocalInput } from "../src/services/generation-local-inputs";

const originalFetch = globalThis.fetch;
const previousUser = useUserStore.getState();
const config = { model: "gpt-image-2", imageModel: "gpt-image-2", size: "1536x1024", quality: "high", count: "1", systemPrompt: "保持衣料纹理", apiKey: "must-never-be-stored" };
let task: any, assets: Map<string, Blob>, requests: Array<{ path: string; method: string }>;
let missing = "", swapped = false, changeOwnerAt = "", responseStatus = 200;
beforeEach(() => {
    assets = new Map(); requests = []; task = undefined; missing = ""; swapped = false; changeOwnerAt = ""; responseStatus = 200;
    useUserStore.setState({ user: { id: "employee-a", role: "designer", status: "active" } as never, status: "authenticated", hydrateSession: async () => {} });
    (globalThis as any).window = { location: { pathname: "/image" } };
    (globalThis as any).FileReader = class {
        result = ""; onload?: () => void;
        readAsDataURL(blob: Blob) { void blob.arrayBuffer().then(bytes => { this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`; this.onload?.(); }); }
    };
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
        const path = String(url), method = init?.method || "GET";
        requests.push({ path, method });
        if (changeOwnerAt === path) useUserStore.setState({ user: { id: "employee-b" } as never });
        if (responseStatus !== 200 && path.startsWith("/api/tasks/")) return new Response("", { status: responseStatus });
        if (path === "/api/models") return Response.json({ models: [{ id: "model-uuid", modelId: "gpt-image-2", name: "GPT" }] });
        if (path === "/api/assets/upload-request") { const id = `asset-${assets.size}`; assets.set(id, new Blob()); return Response.json({ assetId: id, uploadUrl: `/upload/${id}` }); }
        if (path.startsWith("/upload/")) { assets.set(path.split("/").pop()!, init!.body as Blob); return new Response(null, { status: 204 }); }
        if (path === "/api/tasks") { task = { ...JSON.parse(String(init!.body)), id: "task-1", userId: "employee-a", status: "success", resultUrls: ["/result.png"] }; return Response.json({ task }); }
        if (path === "/api/tasks/task-1") return Response.json({ task });
        if (path.startsWith("/api/assets/")) {
            if (path === missing) return new Response("", { status: 404 });
            const blob = assets.get(path.split("/")[3]!);
            return new Response(swapped ? new Blob(["changed"], { type: "image/png" }) : blob);
        }
        throw new Error(`Unexpected HTTP ${method} ${path}`);
    }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; useUserStore.setState(previousUser); delete (globalThis as any).window; delete (globalThis as any).FileReader; });
async function submit() {
    return requestQueuedImages({ modelId: "gpt-image-2", prompt: "保持衣料纹理\n\n设计", count: 1, operationType: "inpaint", tool: "image-generation",
        parameters: { size: "1536x1024", quality: "high" }, draft: generationDraftInput(config as never, "设计"),
        references: ["first-original", "second-original"].map((bytes, index) => ({ id: `ref-${index}`, name: `${index + 1}.png`, type: "image/png", dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}` })) });
}
test("real submission and restoration preserve UUID, effective input, ordered original bytes; restore is GET-only", async () => {
    expect((await submit())[0]!.sourceTaskId).toBe("task-1");
    expect(task.parameters.inputArchive.config).not.toHaveProperty("apiKey");
    expect(task.parameters.inputArchive.effectivePrompt).toBe(task.prompt);
    expect(task.parameters.inputArchive.references.map((ref: any) => ref.name)).toEqual(["1.png", "2.png"]);
    const immutableTask = JSON.stringify(task);
    requests = [];
    const draft = await restoreGenerationDraft("task-1");
    expect(draft.prompt).toBe("设计"); expect(draft.config).toEqual({ ...generationDraftInput(config as never, "").config, model: "model-uuid", imageModel: "model-uuid" });
    expect(draft.references.map(ref => Buffer.from(ref.dataUrl.split(",")[1]!, "base64").toString())).toEqual(["first-original", "second-original"]);
    expect(requests.every(request => request.method === "GET")).toBe(true);
    expect(JSON.stringify(task)).toBe(immutableTask);
});
test("missing later reference rejects the entire draft without upload or task creation", async () => {
    await submit(); missing = task.sourceUrls[1]; requests = [];
    await expect(restoreGenerationDraft("task-1")).rejects.toThrow("原文件不可用");
    expect(requests.every(request => request.method === "GET")).toBe(true);
});
test("changed source bytes cannot silently replace original bytes", async () => {
    await submit(); swapped = true;
    await expect(restoreGenerationDraft("task-1")).rejects.toThrow("不是历史原始字节");
});
test("same-size mutation is detected by SHA-256 on insecure HTTP too", async () => {
    expect(await fingerprintImage(new Blob(["abc"]))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    await submit(); assets.set("asset-0", new Blob(["FIRST-original"], { type: "image/png" }));
    await expect(restoreGenerationDraft("task-1")).rejects.toThrow("不是历史原始字节");
});
test("changed order, foreign URLs and legacy records fail closed", async () => {
    await submit(); task.sourceUrls.reverse();
    await expect(restoreGenerationDraft("task-1")).rejects.toThrow("顺序不一致");
    task.sourceUrls.reverse(); task.sourceUrls[0] = task.parameters.inputArchive.references[0].url = "https://attacker.example/image";
    await expect(restoreGenerationDraft("task-1")).rejects.toThrow("归档不完整");
    delete task.parameters.inputArchive;
    await expect(restoreGenerationDraft("task-1")).rejects.toThrow("旧记录");
});
test("employee changes and 401 responses cancel before a draft is returned", async () => {
    await submit(); changeOwnerAt = task.sourceUrls[0];
    await expect(restoreGenerationDraft("task-1")).rejects.toThrow("员工会话已变化");
    useUserStore.setState({ user: { id: "employee-a" } as never }); changeOwnerAt = ""; responseStatus = 401;
    await expect(restoreGenerationDraft("task-1")).rejects.toThrow("会话已失效");
});
test("other employee archive and changed model identity are rejected", async () => {
    await submit(); task.parameters.inputArchive.ownerId = "employee-b";
    await expect(restoreGenerationDraft("task-1")).rejects.toThrow("其他员工");
    task.parameters.inputArchive.ownerId = "employee-a"; task.parameters.inputArchive.modelId = "changed-model";
    await expect(restoreGenerationDraft("task-1")).rejects.toThrow("原模型已停用或配置已改变");
});
test("scene and mask input restoration rejects altered bytes and unarchived old input", async () => {
    globalThis.fetch = originalFetch;
    const original = new Blob(["original-selection"], { type: "image/png" });
    const input = { id: "mask", name: "选区.png", type: "image/png", dataUrl: `data:image/png;base64,${Buffer.from("original-selection").toString("base64")}`, inputSha256: await fingerprintImage(original) };
    const restored = await restoreLocalInput(input);
    expect(await (await originalFetch(restored.dataUrl)).text()).toBe("original-selection");
    URL.revokeObjectURL(restored.dataUrl);
    await expect(restoreLocalInput({ ...input, dataUrl: `data:image/png;base64,${Buffer.from("modified-selection").toString("base64")}` })).rejects.toThrow("字节已改变");
    await expect(restoreLocalInput({ ...input, inputSha256: undefined })).rejects.toThrow("旧记录");
});
