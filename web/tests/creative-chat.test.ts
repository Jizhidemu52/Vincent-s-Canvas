import { afterEach, describe, expect, test } from "bun:test";

import {
    buildCreativeChatRequestMessages,
    buildCreativeChatTools,
    parseCreativeChatPlan,
    resolveCreativeChatReferences,
    type CreativeChatMessage,
} from "../src/lib/creative-chat";
import { assertCreativeChatReferenceSource, creativeChatPreviewSize, requestCreativeChatPlan } from "../src/services/api/creative-chat";
import type { AiConfig } from "../src/stores/use-config-store";

const image = (id: string) => ({ id, name: `${id}.png`, mimeType: "image/png", dataUrl: `data:image/png;base64,${btoa(id)}` });
const user = (content: string, attachments: CreativeChatMessage["attachments"] = []): CreativeChatMessage => ({ role: "user", content, attachments });
const generated = (...ids: string[]): CreativeChatMessage => ({ role: "assistant", content: "已生成", generatedImages: ids.map(image) });
const tool = (action: string, prompt: string, name = "create_image") => ({ id: "call-1", type: "function" as const, function: { name, arguments: JSON.stringify({ action, prompt }) } });

describe("creative chat reference selection", () => {
    test("a new upload replaces all earlier generated and uploaded batches", () => {
        const references = resolveCreativeChatReferences([user("初稿", [image("old-upload")]), generated("old-result")], user("改成红色", [image("new-upload")]));
        expect(references.map((item) => item.id)).toEqual(["new-upload"]);
    });

    test("a text-only edit inherits the latest complete generated batch", () => {
        const references = resolveCreativeChatReferences([user("用深蓝色", [image("source")]), generated("result-1", "result-2"), user("先讨论一下"), { role: "assistant", content: "可以提高对比度" }], user("按刚才的建议修改，文字保持不变"));
        expect(references.map((item) => item.id)).toEqual(["result-1", "result-2"]);
    });

    test("a more recent upload supersedes older generated images", () => {
        const references = resolveCreativeChatReferences([generated("old-result"), user("新参考", [image("new-reference")])], user("改成蓝色"));
        expect(references.map((item) => item.id)).toEqual(["new-reference"]);
    });

    test("documents and failed output do not replace the last valid image batch", () => {
        const references = resolveCreativeChatReferences([generated("valid-result"), { role: "error", content: "失败", generatedImages: [image("invalid-result")] }], user("按文档改", [{ ...image("brief"), kind: "text", name: "brief.pdf", mimeType: "application/pdf", textContent: "保持文字和图案位置" }]));
        expect(references.map((item) => item.id)).toEqual(["valid-result"]);
    });

    test("never interprets document data URLs as images and deduplicates image bytes", () => {
        expect(resolveCreativeChatReferences([], user("分析附件", [{ id: "pdf", name: "brief.pdf", mimeType: "application/pdf", dataUrl: "data:application/pdf;base64,QQ==" }]))).toEqual([]);
        expect(resolveCreativeChatReferences([], user("编辑", [image("one"), { ...image("one"), id: "duplicate" }])).map((item) => item.id)).toEqual(["one"]);
    });

    test("does not fall back to old images when the current upload is invalid", () => {
        expect(() => resolveCreativeChatReferences([generated("old-result")], user("修改本图", [{ id: "broken", name: "broken.png", mimeType: "image/png", dataUrl: "data:image/png;base64," }]))).toThrow();
    });

    test("rejects an oversized batch instead of silently dropping requested references", () => {
        expect(() => resolveCreativeChatReferences([], user("一起编辑", Array.from({ length: 6 }, (_, index) => image(String(index)))))).toThrow();
    });
});

describe("creative chat model context", () => {
    test("keeps earlier constraints and documents as text and attaches only the latest reference batch", () => {
        const messages = buildCreativeChatRequestMessages([user("蓝底，中文字必须是春日", [image("old-upload")]), generated("new-result")], user("花瓣更细", [{ id: "brief", kind: "text", name: "工艺.pdf", mimeType: "application/pdf", textContent: "印花宽度为 20cm" }]));
        const text = JSON.stringify(messages);
        expect(text).toContain("蓝底，中文字必须是春日");
        expect(text).toContain("印花宽度为 20cm");
        const images = messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((item) => item.type === "image_url") : []);
        expect(images).toEqual([{ type: "image_url", image_url: { url: image("new-result").dataUrl } }]);
        expect(messages[0]!.role).toBe("system");
    });

    test("a company asset URL cannot accidentally be forwarded to the model without a preview", () => {
        expect(() => buildCreativeChatRequestMessages([generated("old")], user("修改"), [{ id: "asset", name: "image.png", type: "image/png", dataUrl: "/api/assets/asset-1/content" }])).toThrow();
    });

    test("exposes only one non-strict whitelisted generation function", () => {
        const tools = buildCreativeChatTools();
        expect(tools).toHaveLength(1);
        expect(tools[0]!.function.name).toBe("create_image");
        expect(tools[0]!.function.strict).toBe(false);
        expect(tools[0]!.function.parameters).toMatchObject({ additionalProperties: false, required: ["action", "prompt"], properties: { action: { enum: ["generate", "edit"] } } });
    });
});

describe("creative chat bounded preview sources", () => {
    test.each([
        [4096, 2048, { width: 1024, height: 512 }],
        [1024, 4096, { width: 256, height: 1024 }],
        [640, 480, { width: 640, height: 480 }],
    ])("resizes %d x %d within 1024px without upscaling", (width, height, expected) => {
        expect(creativeChatPreviewSize(width, height)).toEqual(expected);
    });

    test("rejects invalid dimensions before canvas allocation", () => {
        expect(() => creativeChatPreviewSize(0, 1024)).toThrow();
        expect(() => creativeChatPreviewSize(Infinity, 1024)).toThrow();
    });

    test.each(["https://outside.test/image.png", "http://127.0.0.1:4000/api/assets/a/content", "/api/admin/secrets", "javascript:alert(1)", "data:application/pdf;base64,QQ==", "blob:https://outside.test/example"])("does not fetch an unapproved source %s", (source) => {
        expect(() => assertCreativeChatReferenceSource(source, "https://canvas.test")).toThrow();
    });

    test.each(["/api/assets/a/content", "https://canvas.test/api/assets/a/content", "blob:https://canvas.test/7bba", image("source").dataUrl])("accepts a current-origin image reference %s", (source) => {
        expect(() => assertCreativeChatReferenceSource(source, "https://canvas.test")).not.toThrow();
    });
});

describe("creative chat plan validation", () => {
    test("plain discussion returns no executable image action even when references exist", () => {
        expect(parseCreativeChatPlan({ content: "可以先比较配色，再决定是否生成。", toolCalls: [] }, resolveCreativeChatReferences([], user("讨论", [image("reference")])))).toEqual({ kind: "discussion", content: "可以先比较配色，再决定是否生成。" });
    });

    test("preserves the complete prompt without trimming away user constraints", () => {
        const prompt = "  保留原图构图、中文春日及尺寸 20cm。\n只将花瓣改细，其他不变。  ";
        const references = resolveCreativeChatReferences([generated("latest")], user("修改"));
        expect(parseCreativeChatPlan({ content: "我会保留其他细节。", toolCalls: [tool("edit", prompt)] }, references)).toEqual({ kind: "image", content: "我会保留其他细节。", action: "edit", prompt, references });
    });

    test("reference-based new layouts are editable plans, not reference-free generation", () => {
        const references = resolveCreativeChatReferences([], user("按图设计海报", [image("reference")]));
        expect(parseCreativeChatPlan({ content: "", toolCalls: [tool("edit", "按参考图设计新海报")] }, references)).toMatchObject({ kind: "image", action: "edit", references });
    });

    test("completely new generation needs no image reference", () => {
        expect(parseCreativeChatPlan({ content: "", toolCalls: [tool("generate", "全新创作一张日落海报，不参考之前图片")] }, [])).toMatchObject({ kind: "image", action: "generate", references: [] });
    });

    test.each([
        ["unknown tool", { content: "", toolCalls: [tool("generate", "画花", "delete_asset")] }],
        ["multiple tools", { content: "", toolCalls: [tool("generate", "画花"), tool("generate", "画叶")] }],
        ["blank prompt", { content: "", toolCalls: [tool("generate", " \n ")] }],
        ["long prompt", { content: "", toolCalls: [tool("generate", "花".repeat(20_001))] }],
        ["unknown action", { content: "", toolCalls: [tool("delete", "删除图片")] }],
        ["malformed JSON", { content: "", toolCalls: [{ ...tool("generate", "花"), function: { name: "create_image", arguments: "{" } }] }],
        ["extra argument", { content: "", toolCalls: [{ ...tool("generate", "花"), function: { name: "create_image", arguments: '{"action":"generate","prompt":"花","model":"unapproved"}' } }] }],
        ["missing response", undefined],
        ["empty response", { content: "", toolCalls: [] }],
        ["truncated tool response", { content: "", toolCalls: [tool("generate", "花")], stopReason: "max_tokens" }],
    ])("rejects %s instead of producing an executable plan", (_label, result) => {
        expect(() => parseCreativeChatPlan(result as never, [])).toThrow();
    });

    test("rejects edit when no current or historical image exists", () => {
        expect(() => parseCreativeChatPlan({ content: "", toolCalls: [tool("edit", "改成蓝色")] }, [])).toThrow();
    });
});

describe("creative chat single-request service", () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = originalFetch; });
    const config = { model: "gpt-6-astra", textModel: "gpt-6-astra", systemPrompt: "" } as AiConfig;

    test("requests one auto tool decision and never calls task or image endpoints", async () => {
        const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
        globalThis.fetch = (async (url, init) => {
            requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
            return Response.json({ content: "配色以浅蓝和留白为主。", toolCalls: [] });
        }) as typeof fetch;
        expect(await requestCreativeChatPlan(config, [], user("先讨论配色，不要生成"))).toEqual({ kind: "discussion", content: "配色以浅蓝和留白为主。" });
        expect(requests).toHaveLength(1);
        expect(requests[0]!.url).toBe("/api/chat/responses");
        expect(requests[0]!.body).toMatchObject({ toolChoice: "auto", tools: [{ type: "function", name: "create_image", strict: false }] });
    });

    test.each(["network", "http", "invalid-plan"])("does not retry or generate after %s failure", async (failure) => {
        const requests: string[] = [];
        globalThis.fetch = (async (url) => {
            requests.push(String(url));
            if (failure === "network") throw new TypeError("fetch failed");
            if (failure === "http") return Response.json({ message: "Provider unavailable" }, { status: 502 });
            return Response.json({ content: "", toolCalls: [tool("generate", "花"), tool("generate", "叶")] });
        }) as typeof fetch;
        await expect(requestCreativeChatPlan(config, [], user("生成一朵花"))).rejects.toThrow();
        expect(requests).toEqual(["/api/chat/responses"]);
    });

    test("aborting before planning makes no upstream request", async () => {
        let requests = 0;
        globalThis.fetch = (async () => { requests += 1; throw new Error("must not call"); }) as typeof fetch;
        const controller = new AbortController();
        controller.abort();
        await expect(requestCreativeChatPlan(config, [], user("生成花"), { signal: controller.signal })).rejects.toThrow();
        expect(requests).toBe(0);
    });

    test("loads an owned asset once and plans with a resized copy while preserving the original for editing", async () => {
        const previewUrl = image("small-preview").dataUrl.replace("image/png", "image/jpeg");
        const fixture = installImagePreviewFixture(previewUrl);
        const requests: Array<{ url: string; method: string }> = [];
        let plannerBody: unknown;
        try {
            globalThis.fetch = (async (url, init) => {
                requests.push({ url: String(url), method: init?.method || "GET" });
                if (String(url) === "/api/assets/source-1/content") return new Response("original-image-bytes", { headers: { "content-type": "image/png" } });
                plannerBody = JSON.parse(String(init?.body));
                return Response.json({ content: "", toolCalls: [tool("edit", "保留中文文字，只将花瓣改细")] });
            }) as typeof fetch;
            const plan = await requestCreativeChatPlan(config, [{ role: "assistant", content: "已生成", generatedImages: [{ id: "source-1", dataUrl: "/api/assets/source-1/content" }] }], user("花瓣改细"));
            expect(requests).toEqual([{ url: "/api/assets/source-1/content", method: "GET" }, { url: "/api/chat/responses", method: "POST" }]);
            expect(JSON.stringify(plannerBody)).toContain(previewUrl);
            expect(JSON.stringify(plannerBody)).not.toContain("/api/assets/source-1/content");
            expect(fixture.canvas).toMatchObject({ width: 1024, height: 512 });
            expect(plan.kind === "image" && plan.references[0]!.dataUrl).toBe("/api/assets/source-1/content");
        } finally { fixture.restore(); }
    });

    test("rejects an oversized preview before requesting a decision or creating any task", async () => {
        const fixture = installImagePreviewFixture(`data:image/jpeg;base64,${"A".repeat(2_097_160)}`);
        const requests: string[] = [];
        try {
            globalThis.fetch = (async (url) => { requests.push(String(url)); throw new Error("must not request"); }) as typeof fetch;
            await expect(requestCreativeChatPlan(config, [], user("修改这张图", [image("original")]))).rejects.toThrow("1.5MB");
            expect(requests).toEqual([]);
        } finally { fixture.restore(); }
    });

    test("does not retry a failed source read and never requests a planner or task", async () => {
        const requests: string[] = [];
        globalThis.fetch = (async (url) => { requests.push(String(url)); return new Response("not found", { status: 404 }); }) as typeof fetch;
        await expect(requestCreativeChatPlan(config, [{ role: "assistant", content: "已生成", generatedImages: [{ id: "source", dataUrl: "/api/assets/source/content" }] }], user("修改"))).rejects.toThrow("404");
        expect(requests).toEqual(["/api/assets/source/content"]);
    });
});

// The browser decoder/canvas are the external boundary. Fetch, payload construction,
// reference ownership checks and the production service remain real in these tests.
function installImagePreviewFixture(previewUrl: string) {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previous = { Image: globals.Image, document: globals.document, FileReader: globals.FileReader };
    const canvas = { width: 0, height: 0, getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }), toDataURL: () => previewUrl };
    globals.Image = class {
        naturalWidth = 4096;
        naturalHeight = 2048;
        onload?: () => void;
        set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    };
    globals.document = { createElement: () => canvas };
    globals.FileReader = class {
        result = "";
        onload?: () => void;
        readAsDataURL(blob: Blob) {
            void blob.arrayBuffer().then((bytes) => {
                this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
                this.onload?.();
            });
        }
    };
    return { canvas, restore: () => { Object.assign(globals, previous); } };
}
