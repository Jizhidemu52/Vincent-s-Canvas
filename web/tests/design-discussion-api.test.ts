import { describe, expect, test } from "bun:test";
import { createApi } from "../src/services/api/design-discussion.mjs";
import { assistantRequest } from "../src/components/canvas/design-discussion/design-assistant.mjs";
import { designSessionRequest, requestDesignSession } from "../src/components/canvas/design-discussion/design-session.mjs";
import { mergeServerTask } from "../src/components/canvas/design-discussion/task-model.mjs";
import { createDesignRecord } from "../src/components/canvas/design-discussion/design-record.mjs";
import { createHash } from "node:crypto";

const ownerId = "designer-current";
const projectId = "canvas-current";
const assetId = "11111111-1111-4111-8111-111111111111";
const otherAssetId = "22222222-2222-4222-8222-222222222222";
const image = `/api/assets/${assetId}/content`;
const reference = { id: "local-reference", title: "针织原图.png", image: "data:image/png;base64,c291cmNl" };
const envelope = (data: unknown) => Response.json({ code: 0, data, msg: "ok" });
type Call = { path: string; options?: RequestInit };

function uploadFixture(upload: Record<string, unknown>) {
    const calls: Call[] = [];
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const api = createApi(async (path: string, options?: RequestInit) => {
        calls.push({ path: String(path), options });
        if (path === reference.image) return new Response(bytes, { headers: { "Content-Type": "image/png" } });
        if (path === "/api/assets/upload-request") return envelope(upload);
        if (options?.method === "PUT") return new Response(null, { status: 204 });
        throw new Error(`Unexpected fixture request: ${path}`);
    }, { projectId });
    return { api, calls, bytes };
}

describe("formal design discussion asset API", () => {
    test("HTTP intranet sessions and uploads work without secure-context crypto APIs", async () => {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
        const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
        Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues } });
        try {
            const record = createDesignRecord();
            const discussion = designSessionRequest({ prompt: "讨论针织方向", references: [], previews: [] });
            expect(record.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
            expect(discussion.requestId).not.toBe(record.id);
            const { api, calls, bytes } = uploadFixture({ assetId, uploadUrl: `/api/assets/${assetId}/upload` });
            await api.upload(reference, ownerId);
            const body = JSON.parse(String(calls[1].options?.body));
            expect(body.metadata.contentSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
            expect(body.clientReferenceId).toMatch(/^[a-f0-9-]{36}$/);
            expect(new Uint8Array(await (calls[2].options?.body as Blob).arrayBuffer())).toEqual(bytes);
        } finally {
            if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
            else Reflect.deleteProperty(globalThis, "crypto");
        }
    });

    test.each(["upload", "upload?repair=1", "content-upload", "content-upload?repair=1"])("uploads original bytes through the same asset %s endpoint", async endpoint => {
        const uploadUrl = `/api/assets/${assetId}/${endpoint}`;
        const { api, calls, bytes } = uploadFixture({ assetId, uploadUrl });
        expect(await api.upload(reference, ownerId)).toEqual({ id: reference.id, title: reference.title, image });
        expect(calls.map(call => call.path)).toEqual([reference.image, "/api/assets/upload-request", uploadUrl]);
        const request = calls[1].options;
        expect(request).toMatchObject({ method: "POST", credentials: "same-origin" });
        expect(new Headers(request?.headers).get("x-canvas-owner-id")).toBe(ownerId);
        const body = JSON.parse(String(request?.body));
        expect(body).toMatchObject({ filename: reference.title, mimeType: "image/png", byteSize: bytes.length });
        expect(body.metadata.contentSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(body.clientReferenceId).toMatch(/^[a-f0-9-]{36}$/);
        expect(body.projectId).toBeUndefined();
        const put = calls[2].options;
        expect(put?.method).toBe("PUT");
        expect(new Headers(put?.headers).get("x-canvas-owner-id")).toBe(ownerId);
        expect(new Headers(put?.headers).get("Content-Type")).toBe("image/png");
        expect(new Uint8Array(await (put?.body as Blob).arrayBuffer())).toEqual(bytes);
    });

    test.each([
        `/api/assets/${otherAssetId}/upload`,
        `/api/assets/${otherAssetId}/upload?repair=1`,
        `https://other.invalid/api/assets/${assetId}/upload`,
        `//other.invalid/api/assets/${assetId}/upload`,
        `/api/assets/${assetId}/upload?repair=0`,
        `/api/assets/${assetId}/upload?repair=1&other=1`,
        `/api/assets/${assetId}/upload/extra`,
    ])("rejects an upload address outside the returned asset contract: %s", async uploadUrl => {
        const { api, calls } = uploadFixture({ assetId, uploadUrl });
        await expect(api.upload(reference, ownerId)).rejects.toThrow("服务器上传地址不受支持");
        expect(calls.some(call => call.options?.method === "PUT")).toBe(false);
        expect(calls).toHaveLength(2);
    });

    test("rejects an invalid server asset identity before uploading bytes", async () => {
        const { api, calls } = uploadFixture({ assetId: "../../foreign", uploadUrl: "/api/assets/foreign/upload" });
        await expect(api.upload(reference, ownerId)).rejects.toThrow("无效的素材编号");
        expect(calls.some(call => call.options?.method === "PUT")).toBe(false);
    });

    test("reuses a server-owned reference without fetching or uploading again", async () => {
        const { api, calls } = uploadFixture({ assetId, uploadUrl: null });
        expect(await api.upload({ ...reference, image }, ownerId)).toEqual({ id: reference.id, title: reference.title, image });
        expect(calls).toHaveLength(0);
        expect(await api.upload(reference, ownerId)).toEqual({ id: reference.id, title: reference.title, image });
        expect(calls).toHaveLength(2);
    });
});

describe("formal design discussion task receipts", () => {
    const local = { id: "local-task", requestId: "original-request", projectId, resultUrls: [] };
    const receipt = { id: "server-task", requestId: local.requestId, userId: ownerId, projectId, status: "success", resultUrls: [image] };

    test("accepts formal userId ownership and preserves only owned result URLs", () => {
        const result = mergeServerTask(local, { ...receipt, resultUrls: [image, "https://other.invalid/result.png", "/api/assets/not-an-id/content"] }, ownerId);
        expect(result).toMatchObject({ id: local.id, requestId: local.requestId, taskId: receipt.id, projectId, status: "success", resultUrls: [image] });
        expect(mergeServerTask(local, { ...receipt, ownerUserId: ownerId }, ownerId).taskId).toBe(receipt.id);
        expect(mergeServerTask(local, { ...receipt, userId: undefined, ownerUserId: ownerId }, ownerId).taskId).toBe(receipt.id);
    });

    test.each([
        { userId: "foreign-owner" },
        { userId: undefined, ownerUserId: undefined },
        { ownerUserId: ownerId, userId: "foreign-owner" },
        { ownerUserId: "foreign-owner", userId: ownerId },
        { requestId: "foreign-request" },
        { projectId: "foreign-canvas" },
        { id: "" },
    ])("rejects conflicting ownership, request or canvas identity: %j", overrides => {
        expect(() => mergeServerTask(local, { ...receipt, ...overrides }, ownerId)).toThrow("任务身份不匹配");
        expect(local.resultUrls).toEqual([]);
    });

    test.each([
        { mediaKind: "image", references: [], toolKey: "image", operationType: "image_generation" },
        { mediaKind: "image", references: [{ ...reference, image }], toolKey: "image-edit", operationType: "inpaint" },
        { mediaKind: "video", references: [{ ...reference, image }], toolKey: "canvas-video", operationType: "video_generation" },
    ])("submits $operationType against the current canvas with the original request ID", async variant => {
        const calls: Call[] = [];
        const api = createApi(async (path: string, options?: RequestInit) => {
            calls.push({ path, options });
            return envelope({ task: receipt });
        }, { projectId });
        const task = { ...local, ...variant, modelId: "configured-model", prompt: "保留款式与纹理", parameters: { seconds: 6 } };
        expect(await api.submit(task, ownerId)).toEqual(receipt);
        expect(calls).toHaveLength(1);
        expect(calls[0].path).toBe("/api/tasks");
        expect(JSON.parse(String(calls[0].options?.body))).toEqual({ requestId: local.requestId, projectId, toolKey: variant.toolKey, operationType: variant.operationType, modelConfigId: task.modelId, prompt: task.prompt, sourceUrls: variant.references.map(ref => ref.image), parameters: task.parameters });
        expect(new Headers(calls[0].options?.headers).get("x-canvas-owner-id")).toBe(ownerId);
    });
});

describe("dedicated design discussion LLM route", () => {
    test("both discussion and image-planning requests select canvas-design-chat independently", () => {
        const options = { prompt: "先讨论蓝灰色针织方向", references: [], previews: [] };
        for (const request of [designSessionRequest(options), assistantRequest(options)]) {
            expect(request.toolKey).toBe("canvas-design-chat");
            expect(request.webSearch).toBe(false);
            expect(request.tools).toEqual([]);
            expect(request.model).toBeUndefined();
            expect(request.modelConfigId).toBeUndefined();
        }
    });

    test("a discussion calls only the chat endpoint and retains authenticated owner headers", async () => {
        const calls: Call[] = [];
        const api = createApi(async (path: string, options?: RequestInit) => {
            calls.push({ path, options });
            if (path === "/api/auth/session") return envelope({ user: { id: ownerId, status: "active" } });
            if (path === "/api/chat/responses") return envelope({ content: JSON.stringify({ message: "先确认蓝灰色方向与针织肌理。", questions: [], proposals: [], sources: [], trendStatus: "未实时检索" }), toolCalls: [] });
            throw new Error(`Unexpected fixture request: ${path}`);
        }, { projectId });
        const result = await requestDesignSession(api, ownerId, { prompt: "先讨论蓝灰色针织方向", references: [], mode: "discuss" });
        expect(result.proposals).toEqual([]);
        expect(result.message).toContain("蓝灰色");
        const posts = calls.filter(call => call.options?.method === "POST");
        expect(posts).toHaveLength(1);
        expect(posts[0].path).toBe("/api/chat/responses");
        expect(JSON.parse(String(posts[0].options?.body))).toMatchObject({ toolKey: "canvas-design-chat", tools: [], toolChoice: "none" });
        expect(new Headers(posts[0].options?.headers).get("x-canvas-owner-id")).toBe(ownerId);
        expect(calls.some(call => call.path.startsWith("/api/tasks") || call.path.startsWith("/api/assets"))).toBe(false);
    });
});
