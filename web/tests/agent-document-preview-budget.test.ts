import { afterEach, expect, test } from "bun:test";
import { prepareChatProfileInput, validateChatProfileOutput } from "../../server/src/prompt-chat-profiles";
import type { AgentDocument } from "../../shared/image-agent-documents";
import { requestCreativeChatPlan } from "../src/services/api/creative-chat";
import type { AiConfig } from "../src/stores/use-config-store";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const config = { model: "gpt-6-astra", textModel: "gpt-6-astra", systemPrompt: "" } as AiConfig;
const pixels = (name: string) => `data:image/png;base64,${btoa(name)}`;
const preview = (source: string) => `data:image/jpeg;base64,${btoa(`preview:${source}`)}`;
const image = (id: string) => ({ id, name: `${id}.png`, kind: "image" as const, mimeType: "image/png", dataUrl: pixels(id) });

function documentFixture(id: string, kind: "docx" | "pdf", pages: number): AgentDocument {
    const mimeType = kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    return { id, name: `${id}.${kind}`, kind, mimeType, bytes: 10,
        source: { name: `${id}.${kind}`, mimeType, dataUrl: `data:${mimeType};base64,${btoa(`original:${id}`)}` },
        sections: Array.from({ length: pages }, (_, index) => ({ id: `${id}:s${index + 1}`, title: `第${index + 1}页`, text: `资料正文${index + 1}`, figureIds: [`${id}:f${index + 1}`] })),
        figures: Array.from({ length: pages }, (_, index) => ({ id: `${id}:f${index + 1}`, sectionId: `${id}:s${index + 1}`, label: `第${index + 1}页`, name: `${id}-${index + 1}.png`, mimeType: "image/png", dataUrl: pixels(`${id}:f${index + 1}`) })), warnings: [] };
}

function previewFixture() {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previous = { Image: globals.Image, document: globals.document };
    globals.Image = class {
        naturalWidth = 2048; naturalHeight = 1024; sourceUrl = ""; onload?: () => void;
        set src(value: string) { this.sourceUrl = value; queueMicrotask(() => this.onload?.()); }
    };
    globals.document = { createElement: () => {
        let source = "";
        return { width: 0, height: 0, getContext: () => ({ fillStyle: "", fillRect() {}, drawImage(image: { sourceUrl: string }) { source = image.sourceUrl; } }), toDataURL: () => preview(source) };
    } };
    return () => Object.assign(globals, previous);
}

function planningFixture(documentId: string, sectionCount: number) {
    const requests: any[] = [];
    globalThis.fetch = (async (url, init) => {
        if (String(url) === "/api/models") return Response.json({ models: [{ id: "document-budget-chat", modelId: "gpt-6-astra", name: "isolated", capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 }], tools: [{ toolKey: "gpt-chat", modelConfigId: "document-budget-chat", enabled: true, configurationVersion: 1 }], prices: [] });
        if (String(url) !== "/api/chat/responses") throw new Error(`Unexpected request: ${url}`);
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        // Exercise the real transport conversion and server boundary, not an E2E
        // route that accepts an oversized request which production would reject.
        const prepared = await prepareChatProfileInput(body);
        const result = requests.length === 1 ? { content: "先查阅资料。", toolCalls: [{ id: "read-1", type: "function" as const, function: { name: "read_document", arguments: JSON.stringify({ document_id: documentId, section_start: 1, section_count: sectionCount }) } }] }
            : { content: "文字已查阅；未呈现图像的细节待确认。", toolCalls: [] };
        return Response.json(validateChatProfileOutput(result, prepared.privateRules));
    }) as typeof fetch;
    return requests;
}

const imageUrls = (request: any): string[] => request.input.flatMap((item: any) => Array.isArray(item.content) ? item.content.filter((part: any) => part.type === "input_image").map((part: any) => part.image_url) : []);

test.each([
    { count: 4, kind: "docx" as const, pages: 1, expectedCount: 5 },
    { count: 5, kind: "pdf" as const, pages: 3, expectedCount: 5 },
])("$count working images plus a $kind lookup preserve the locked base without exceeding the server budget", async ({ count, kind, pages, expectedCount }) => {
    const restore = previewFixture();
    const document = documentFixture("brief", kind, pages);
    const current = { id: "u1", role: "user" as const, content: "整理文件需求，当前底图与已选参考图保持不变", attachments: Array.from({ length: count }, (_, index) => image(`work-${index}`)) };
    const before = JSON.stringify({ document, current });
    const requests = planningFixture(document.id, pages);
    try {
        expect(await requestCreativeChatPlan(config, [], current, { explicitTargetImageId: "work-0", documents: [document] })).toMatchObject({ kind: "discussion" });
        expect(requests).toHaveLength(2);
        expect(imageUrls(requests[0])).toHaveLength(5);
        expect(imageUrls(requests[1])).toHaveLength(expectedCount);
        for (const attachment of current.attachments) expect(imageUrls(requests[1])).toContain(preview(attachment.dataUrl));
        expect(requests[1].profileContext).toMatchObject({ focusImageId: "work-0", lockedImageId: "work-0", documentsInspected: true });
        expect(requests[1].input.at(-1)).toEqual({ role: "user", content: current.content });
        const toolResult = requests[1].input.find((item: any) => item.type === "function_call_output");
        expect(toolResult.output).toContain("资料正文1");
        if (count === 4) expect(imageUrls(requests[1])).toContain(preview(document.figures[0]!.dataUrl));
        else {
            for (const figure of document.figures) { expect(imageUrls(requests[1])).not.toContain(preview(figure.dataUrl)); expect(toolResult.output).toContain(figure.id); }
            expect(toolResult.output).toContain("未呈现");
        }
        expect(JSON.stringify(requests)).not.toContain(document.source!.dataUrl);
        expect(JSON.stringify({ document, current })).toBe(before);
    } finally { restore(); }
});

test("a three-page lookup replaces unrelated first-page document previews instead of accumulating them", async () => {
    const restore = previewFixture();
    const documents = [documentFixture("brief", "pdf", 3), documentFixture("other", "pdf", 1), documentFixture("third", "docx", 1)];
    const requests = planningFixture("brief", 3);
    try {
        await requestCreativeChatPlan(config, [], { id: "u1", role: "user", content: "查阅第一份文件的前三页" }, { documents });
        expect(requests).toHaveLength(2);
        expect(imageUrls(requests[0])).toHaveLength(3);
        expect(imageUrls(requests[1])).toEqual(documents[0]!.figures.map(figure => preview(figure.dataUrl)));
        expect(requests[1].input.at(-1)).toEqual({ role: "user", content: "查阅第一份文件的前三页" });
    } finally { restore(); }
});
