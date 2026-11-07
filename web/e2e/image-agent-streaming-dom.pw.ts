import { createServer, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { test, expect, IMAGE, newCanvas, uploadImage } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";

const PREFIX = "这件针织衫适合浅蓝色搭配，";
const SUFFIX = "保留原有纹理即可。本轮仅分析，没有生成图片。";
const ANSWER = PREFIX + SUFFIX;
const THINKING = "FIXTURE_PRIVATE_THINKING_DO_NOT_RENDER";
const TOOL_ID = "FIXTURE_PRIVATE_TOOL_DO_NOT_RENDER";
const output = resolve(import.meta.dirname, "../../output/image-agent-validation/streaming-dom-acceptance");
test.skip(({ baseURL }) => baseURL !== "http://127.0.0.1:5298", "Requires the dedicated local SSE proxy configuration; never use a running installation.");
type Entry = "chat" | "canvas";
type StreamRecord = { request: Record<string, any>; receivedAt: number; writes: Array<{ type: string; at: number }>; stopWritten: boolean; response: ServerResponse };

async function streamServer(entry: Entry) {
    const records: StreamRecord[] = [];
    const failures: string[] = [];
    const server = createServer(async (request, response) => {
        if (request.url !== "/api/chat/responses" || request.method !== "POST") {
            failures.push(`${request.method} ${request.url}`);
            response.writeHead(404).end();
            return;
        }
        let body = "";
        for await (const chunk of request) body += chunk;
        const record: StreamRecord = { request: JSON.parse(body), receivedAt: Date.now(), writes: [], stopWritten: false, response };
        records.push(record);
        response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
        response.flushHeaders();
        send(record, { type: "message_start", message: { id: `fixture-${records.length}`, role: "assistant", content: [], model: "claude-sonnet-5-5" } });
        send(record, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
        send(record, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: THINKING } });
        send(record, { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "FIXTURE_SIGNATURE_DO_NOT_RENDER" } });
        send(record, { type: "content_block_stop", index: 0 });
        send(record, { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
        send(record, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: PREFIX } });
        if (records.length === 1) {
            send(record, { type: "content_block_stop", index: 1 });
            const toolName = entry === "chat" ? "look_at_images" : "canvas_get_state";
            const args = entry === "chat" ? { image_ids: [record.request.profileContext.imageCatalog[0].id] } : {};
            const raw = JSON.stringify(args), midpoint = Math.max(1, Math.floor(raw.length / 2));
            send(record, { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: TOOL_ID, name: toolName, input: {} } });
            send(record, { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: raw.slice(0, midpoint) } });
            send(record, { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: raw.slice(midpoint) } });
            send(record, { type: "content_block_stop", index: 2 });
        }
        // Deliberately keep the HTTP body open: only the test may release its
        // next text fragment or message_stop, after observing the actual DOM.
    });
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(59887, "127.0.0.1", done); });
    return {
        records, failures,
        sendSuffix(record: StreamRecord) { send(record, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: SUFFIX } }); },
        finish(record: StreamRecord, reason: "tool_use" | "end_turn") {
            send(record, { type: "message_delta", delta: { stop_reason: reason } });
            send(record, { type: "message_stop" });
            record.stopWritten = true;
            record.response.end();
        },
        async close() {
            for (const record of records) record.response.destroy();
            server.closeAllConnections();
            await new Promise<void>(done => server.close(() => done()));
        },
    };
}

function send(record: StreamRecord, payload: Record<string, unknown>) {
    record.writes.push({ type: String(payload.type), at: Date.now() });
    record.response.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function models(context: BrowserContext) {
    const models = [
        { id: "fixture-chat-streaming", modelId: "claude-sonnet-5-5", name: "隔离流式对话", protocol: "anthropic", capabilities: ["chat"], creditCost: 0, rmbCost: 0 },
        { id: "fixture-image-streaming", modelId: "gpt-image-2", name: "禁止调用的隔离图片模型", protocol: "openai", imageParameterProfile: "standard", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    ];
    await context.route("**/api/models", route => route.fulfill({ json: { models, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: /chat|text|agent/.test(tool.toolKey) ? models[0].id : models[1].id, configurationVersion: 1 })) } }));
    await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
    // This is a real network continuation, not fulfill() with a buffered body.
    // The isolated Vite proxy points only at the local HTTP fixture above.
    await context.route("**/api/chat/responses", route => route.continue());
}

async function start(entry: Entry, page: Page) {
    if (entry === "chat") {
        await page.goto("/chat");
        const chooser = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: "上传图片", exact: true }).click();
        await (await chooser).setFiles({ name: "流式验收原图.png", mimeType: "image/png", buffer: IMAGE });
        await expect(page.getByRole("button", { name: "移除 流式验收原图.png", exact: true })).toBeVisible();
        await page.getByRole("textbox", { name: "对话内容", exact: true }).fill("只分析图片的搭配建议，不生成也不修改图片。");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        return page.locator("main");
    }
    await newCanvas(page);
    await uploadImage(page, "流式验收原图.png");
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel");
    await panel.getByPlaceholder("理解画布、修改图片或批量编排…").fill("先只读画布，再分析图片搭配建议，不生成也不修改图片。");
    await panel.getByRole("button", { name: "发送", exact: true }).click();
    return panel;
}

async function noPrivateText(panel: Locator) {
    const text = await panel.innerText();
    for (const hidden of [THINKING, TOOL_ID, "FIXTURE_SIGNATURE_DO_NOT_RENDER", "input_json_delta", "thinking_delta", '"image_ids"', '"tool_use"']) expect(text).not.toContain(hidden);
    await expect(panel.getByTestId("canvas-agent-tool-detail")).toHaveCount(0);
    return text;
}

for (const entry of ["chat", "canvas"] as const) {
    test(`${entry}: real HTTP fragments reach DOM before message_stop; private blocks stay hidden`, async ({ page, context, api }, info) => {
        const fixture = await streamServer(entry);
        const observations: Array<Record<string, unknown>> = [];
        const network: Array<{ method: string; path: string }> = [];
        context.on("request", request => { if (request.url().includes("/api/")) network.push({ method: request.method(), path: new URL(request.url()).pathname }); });
        try {
            await models(context);
            const panel = await start(entry, page);
            await expect.poll(() => fixture.records.length).toBe(1);
            await expect(panel.getByText(PREFIX, { exact: true })).toBeVisible();
            expect(fixture.records[0].stopWritten).toBe(false);
            observations.push({ phase: "tool-stream-prefix-visible-before-stop", at: Date.now(), stopWritten: false, visibleText: await noPrivateText(panel) });
            expect(api.submissions).toHaveLength(0);
            await page.screenshot({ path: info.outputPath(`${entry}-tool-stream-before-stop.png`), animations: "disabled" });
            fixture.finish(fixture.records[0], "tool_use");
            await expect.poll(() => fixture.records.length).toBe(2);
            await expect(panel.getByText(PREFIX, { exact: true })).toBeVisible();
            expect(fixture.records[1].stopWritten).toBe(false);
            observations.push({ phase: "continuation-prefix-visible-before-stop", at: Date.now(), stopWritten: false, visibleText: await noPrivateText(panel) });
            fixture.sendSuffix(fixture.records[1]);
            await expect(panel.getByText(ANSWER, { exact: true })).toBeVisible();
            expect(fixture.records[1].stopWritten).toBe(false);
            observations.push({ phase: "complete-text-visible-before-stop", at: Date.now(), stopWritten: false, visibleText: await noPrivateText(panel) });
            await page.screenshot({ path: info.outputPath(`${entry}-complete-text-before-stop.png`), animations: "disabled" });
            fixture.finish(fixture.records[1], "end_turn");
            await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeVisible();
            await expect(panel.getByText(ANSWER, { exact: true })).toHaveCount(1);
            await expect(panel.getByText(PREFIX, { exact: true })).toHaveCount(0);
            if (entry === "chat") await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(1);
            observations.push({ phase: "final-unique-complete-answer", at: Date.now(), visibleText: await noPrivateText(panel) });
            await page.screenshot({ path: info.outputPath(`${entry}-final.png`), animations: "disabled" });
            expect(fixture.records).toHaveLength(2);
            expect(fixture.failures).toEqual([]);
            expect(api.submissions).toHaveLength(0);
            expect(api.batchSubmissions).toHaveLength(0);
            expect(network.filter(item => item.method === "POST" && item.path.startsWith("/api/tasks"))).toEqual([]);
            for (const record of fixture.records) expect(record.request.claude?.stream).toBe(true);
            const paths = ["web/e2e/image-agent-streaming-dom.pw.ts", "web/src/services/api/image.ts", "web/src/services/api/creative-chat.ts", "web/src/pages/chat/index.tsx", "web/src/pages/chat/chat-stream-buffer.ts", "web/src/components/canvas/canvas-assistant-panel.tsx", "web/src/components/canvas/canvas-agent-chat-ui.tsx"];
            const sourceSha256 = Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash("sha256").update(await readFile(resolve(import.meta.dirname, "../..", path))).digest("hex")])));
            const evidence = { entry, status: "passed", origin: info.project.use.baseURL, transport: "real local HTTP SSE through isolated Vite proxy; no route.fulfill for chat", sourceSha256, observations, streams: fixture.records.map(({ response: _response, ...record }) => record), network, blockedExternal: api.blocked, unexpectedApi: api.unexpected, pageErrors: api.pageErrors, imageTaskPosts: api.submissions.length, batchTaskPosts: api.batchSubmissions.length, limitations: "Local deterministic fixtures verify frontend streaming and privacy; not real provider latency, live API compatibility, visual model fidelity or production deployment." };
            await writeFile(resolve(output, `${entry}-evidence.json`), JSON.stringify(evidence, null, 2));
        } finally {
            await fixture.close();
        }
    });
}
