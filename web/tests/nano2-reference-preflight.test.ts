import { afterEach, beforeEach, expect, test } from "bun:test";
import { imageReferenceFileError, validateImageReferences } from "../src/lib/image-reference-policy";
import { requestQueuedImageBatch, requestQueuedImages } from "../src/services/api/generation-tasks";
import { useUserStore } from "../src/stores/use-user-store";

const MiB = 1024 * 1024;
const originalFetch = globalThis.fetch;
const globals = globalThis as unknown as Record<string, unknown>;
const originalReader = globals.FileReader;
const originalWindow = globals.window;
const originalUser = useUserStore.getState();
const model = { id: "nano2-config", name: "Image model", modelId: "gemini-3.1-flash-image-preview-official", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 1 };
beforeEach(() => {
    useUserStore.setState({ user: { id: "nano2-preflight-owner", role: "designer" } as never, status: "authenticated", hydrateSession: async () => {} });
    globals.window = { location: { pathname: "/image" } };
    globals.FileReader = class {
        result = "";
        onload?: () => void;
        readAsDataURL(blob: Blob) {
            void blob.arrayBuffer().then(bytes => {
                this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
                this.onload?.();
            });
        }
    };
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    globals.FileReader = originalReader;
    globals.window = originalWindow;
    useUserStore.setState(originalUser, true);
});

test("model-specific file validation preserves original bytes and permits the exact Nano2 boundary", async () => {
    const bytes = new Uint8Array(10 * MiB + 1).fill(17);
    const original = new File([bytes], "original.png", { type: "image/png" });
    expect(imageReferenceFileError(original, { kind: "gemini" })).toContain("单张 10 MiB");
    expect(imageReferenceFileError(original, { kind: "gemini" })).toContain("原图未修改");
    expect(imageReferenceFileError({ size: 10 * MiB, type: "image/png" }, { kind: "gemini" })).toBeUndefined();
    expect(imageReferenceFileError(original, { kind: "midjourney-blend" })).toBeUndefined();
    expect(imageReferenceFileError(original, { kind: "standard" })).toBeUndefined();
    expect(imageReferenceFileError({ size: 0, type: "image/png" }, { kind: "gemini" })).toContain("为空");
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(bytes);
});

test.each([undefined, 1])("resolved URL original is checked even when its cached byte size is %s", async cachedBytes => {
    const source = new Uint8Array(10 * MiB + 1).fill(31);
    const reference = { id: "original", name: "original.png", type: "image/png", dataUrl: "/api/assets/original/content", bytes: cachedBytes };
    // The old synchronous metadata check cannot know this URL's actual size.
    expect(validateImageReferences(model.modelId, [reference]).valid).toBe(true);
    const requests: string[] = [];
    let submissionStarted = 0;
    globalThis.fetch = (async url => {
        requests.push(String(url));
        if (String(url) !== reference.dataUrl) throw new Error("No upload or task is allowed");
        return new Response(source, { headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    await expect(requestQueuedImages({ modelId: model.modelId, resolvedModel: model, prompt: "Recolor", count: 1, operationType: "inpaint", references: [reference], onSubmissionStarted: () => { submissionStarted++; } })).rejects.toThrow("单张 10 MiB");
    expect(requests).toEqual([reference.dataUrl]);
    expect(submissionStarted).toBe(0);
    expect(reference.bytes).toBe(cachedBytes);
    expect(source[0]).toBe(31);
    expect(source.length).toBe(10 * MiB + 1);
});

test("resolved MIME takes precedence over stale reference metadata before any upload", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async url => { requests.push(String(url)); return new Response("gif", { headers: { "content-type": "image/gif" } }); }) as typeof fetch;
    await expect(requestQueuedImages({ modelId: model.modelId, resolvedModel: model, prompt: "Recolor", count: 1, operationType: "inpaint", references: [{ id: "source", name: "source.png", type: "image/png", dataUrl: "/source" }] })).rejects.toThrow("JPEG、PNG 或 WebP");
    expect(requests).toEqual(["/source"]);
});

test("an all-oversized Nano2 batch never uploads assets or submits a task", async () => {
    const file = new File([new Uint8Array(10 * MiB + 1)], "oversized.png", { type: "image/png" });
    let requests = 0, submissions = 0;
    globalThis.fetch = (async () => { requests++; throw new Error("No request is allowed"); }) as typeof fetch;
    await expect(requestQueuedImageBatch({ modelId: model.modelId, resolvedModel: model, prompt: "Recolor", files: [{ file, title: "one" }], onSubmissionStarted: () => { submissions++; } })).rejects.toThrow("单张 10 MiB");
    expect(requests).toBe(0);
    expect(submissions).toBe(0);
});

test("mixed Nano2 batch omits only invalid files and preserves original positions and valid file bytes", async () => {
    const bad = new File([new Uint8Array(10 * MiB + 1)], "oversized.png", { type: "image/png" });
    const good = new File(["original valid bytes"], "good.png", { type: "image/png" });
    let uploadedBody: BodyInit | null | undefined;
    let submission: Record<string, unknown> | undefined;
    globalThis.fetch = (async (url, init) => {
        if (String(url) === "/api/assets/upload-request") return Response.json({ assetId: "good-asset", uploadUrl: "/upload-good" });
        if (String(url) === "/upload-good") { uploadedBody = init?.body; return new Response(null, { status: 204 }); }
        if (String(url) === "/api/tasks/batch") { submission = JSON.parse(String(init?.body)); return Response.json({ batchId: "batch", tasks: [], failures: [{ index: 0, reason: "fixture admission refusal" }] }); }
        throw new Error("Unexpected request");
    }) as typeof fetch;
    const result = await requestQueuedImageBatch({ modelId: model.modelId, resolvedModel: model, prompt: "Recolor", files: [{ file: bad, title: "bad" }, { file: good, title: "good" }] });
    expect(uploadedBody).toBe(good);
    expect(await good.text()).toBe("original valid bytes");
    expect(submission?.items).toEqual([{ sourceUrls: ["/api/assets/good-asset/content"] }]);
    expect(result.failures.map(item => item.index)).toEqual([0, 1]);
    expect(result.failures[0]!.reason).toContain("单张 10 MiB");
});
