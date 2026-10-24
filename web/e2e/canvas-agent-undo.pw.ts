import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, newCanvas, editText } from "./fixtures";

/** Disposable protocol double, never the installed local Agent or a model. */
async function mockAgent(context: BrowserContext) {
    const streams = new Set<ServerResponse>();
    const results: Array<{ requestId: string; error?: string; result?: unknown }> = [];
    const unexpected: string[] = [];
    let endpoint = "";
    const server = createServer(async (request, response) => {
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "content-type");
        response.setHeader("Access-Control-Allow-Private-Network", "true");
        if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
        const path = new URL(request.url!, "http://fixture").pathname;
        const json = (value: unknown, status = 200) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
        if (request.method === "GET" && path === "/config") { json({ ok: true, url: endpoint, token: "isolated-e2e-token" }); return; }
        if (request.method === "GET" && path === "/events") {
            streams.add(response);
            response.once("close", () => streams.delete(response));
            response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
            response.write("event: hello\ndata: {}\n\n");
            return;
        }
        if (request.method === "GET" && path === "/agent/codex/threads") { json({ ok: true, data: [] }); return; }
        if (request.method === "POST" && ["/canvas/state", "/canvas/result"].includes(path)) {
            try {
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                if (path === "/canvas/result") results.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                json({ ok: true });
            } catch (error) {
                unexpected.push(`Invalid ${path}: ${String(error)}`);
                json({ error: "INVALID_FIXTURE_REQUEST" }, 400);
            }
            return;
        }
        // A prompt/model request is deliberately not implemented in this test.
        unexpected.push(`${request.method} ${path}`);
        json({ error: "UNEXPECTED_AGENT_REQUEST" }, 501);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Override the fixture's deny-all rule for this exact ephemeral server only.
    // Native EventSource remains in use; no browser globals or stores are patched.
    await context.route(`${endpoint}/**`, route => route.continue());
    return {
        endpoint, streams, results, unexpected,
        emit: (event: string, data: unknown) => {
            expect(streams.size, "The real page must be connected before a tool event is sent").toBe(1);
            for (const stream of streams) stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        },
        close: async () => {
            for (const stream of streams) stream.destroy();
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
}

async function connectAgent(page: Page, agent: Awaited<ReturnType<typeof mockAgent>>) {
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "对话选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "本机 Agent", exact: true }).click();
    await panel.getByRole("tablist", { name: "Agent 面板", exact: true }).getByRole("tab", { name: "连接", exact: true }).click();
    await panel.getByPlaceholder("例如 http://127.0.0.1:17371", { exact: true }).fill(agent.endpoint);
    await panel.getByPlaceholder("自动发现，或手动填入 Connect token", { exact: true }).fill("isolated-e2e-token");
    await panel.getByRole("button", { name: /^连\s*接$/ }).click();
    await expect.poll(() => agent.streams.size).toBe(1);
    await expect(panel.getByText("已连接", { exact: true })).toBeVisible();
    await panel.getByRole("tablist", { name: "Agent 面板", exact: true }).getByRole("tab", { name: "对话", exact: true }).click();
    return panel;
}

test("Agent 精确撤销保留手工改文，提示字段冲突，Ctrl+Z 与重做仅回放安全逆操作", async ({ page, context, api }, testInfo) => {
    await context.route("**/api/generation-capabilities?*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ models: [] }) }));
    const agent = await mockAgent(context);
    try {
        const id = await newCanvas(page);
        await page.getByRole("button", { name: "文本", exact: true }).click();
        await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
        const nodeId = api.document(id)!.nodes[0].id;
        await editText(page, nodeId, "原始手工文本");
        await expect.poll(() => api.document(id)?.nodes[0].metadata.content).toBe("原始手工文本");
        const originalWidth: number = api.document(id)!.nodes[0].width;
        const agentWidth = originalWidth + 80;
        const node = page.locator(`[data-node-id="${nodeId}"]`);
        const panel = await connectAgent(page, agent);
        agent.emit("tool_call", { requestId: "precise-undo-fixture", name: "canvas_apply_ops", input: { ops: [
            { type: "update_node", id: nodeId, patch: { width: agentWidth }, metadata: { content: "Agent 写入文本" } },
        ] } });
        await expect(panel.getByText("确认工具调用", { exact: true })).toBeVisible();
        await panel.getByRole("button", { name: "批准执行", exact: true }).click();
        await expect.poll(() => agent.results.length).toBe(1);
        expect(agent.results[0].error).toBeUndefined();
        await expect(node).toContainText("Agent 写入文本");
        await expect(node).toHaveCSS("width", `${agentWidth}px`);
        await expect.poll(() => api.document(id)?.nodes[0].width).toBe(agentWidth);
        agent.emit("agent_event", { type: "item.completed", item: { id: "fixture-reply", type: "agent_message", text: "模拟回复：已修改文本和宽度。" } });
        agent.emit("agent_event", { type: "turn.completed" });
        await expect(panel.getByText("模拟回复：已修改文本和宽度。", { exact: true })).toBeVisible();

        // A real textarea edit now conflicts with the agent's content field.
        // Width is untouched and therefore remains independently reversible.
        await editText(page, nodeId, "后续手工内容必须保留");
        await expect.poll(() => api.document(id)?.nodes[0].metadata.content).toBe("后续手工内容必须保留");
        const undoAgent = panel.getByRole("button", { name: /^撤\s*销$/ });
        await expect(undoAgent).toBeEnabled();
        await undoAgent.click();
        const conflict = page.locator(".ant-modal-confirm").filter({ hasText: "助手操作已部分撤销" });
        await expect(conflict).toBeVisible();
        await expect(conflict).toContainText("metadata.content");
        await expect(conflict).toContainText("保留当前内容");
        await expect(node).toContainText("后续手工内容必须保留");
        await expect(node).toHaveCSS("width", `${originalWidth}px`);
        await expect.poll(() => api.document(id)?.nodes[0].width).toBe(originalWidth);
        expect(api.document(id)!.nodes[0].metadata.content).toBe("后续手工内容必须保留");
        await conflict.screenshot({ path: testInfo.outputPath("agent-undo-conflict.png") });
        await conflict.getByRole("button").last().click();
        await expect(conflict).toBeHidden();
        await expect(panel.getByText(/已部分撤销 1 项修改/)).toBeVisible();
        await expect(undoAgent).toBeEnabled(); // Only the conflicted field remains retryable.

        await node.click({ position: { x: 20, y: 12 } });
        await page.keyboard.press("Control+z");
        await expect(node).toHaveCSS("width", `${agentWidth}px`);
        await expect(node).toContainText("后续手工内容必须保留");
        await expect.poll(() => api.document(id)?.nodes[0].width).toBe(agentWidth);
        expect(api.document(id)!.nodes[0].metadata.content).toBe("后续手工内容必须保留");
        await page.keyboard.press("Control+Shift+z");
        await expect(node).toHaveCSS("width", `${originalWidth}px`);
        await expect(node).toContainText("后续手工内容必须保留");
        await expect.poll(() => api.document(id)?.nodes[0].width).toBe(originalWidth);
        expect(api.document(id)!.nodes[0].metadata.content).toBe("后续手工内容必须保留");
        await expect(panel.getByText("模拟回复：已修改文本和宽度。", { exact: true })).toBeVisible();

        // Verify the resulting persisted graph, not just optimistic DOM state.
        await page.reload();
        await expect(node).toBeVisible();
        await expect(node).toHaveCSS("width", `${originalWidth}px`);
        await expect(node).toContainText("后续手工内容必须保留");
        expect(api.document(id)!.nodes).toHaveLength(1);
        expect(api.submissions).toHaveLength(0);
        expect(api.batchSubmissions).toHaveLength(0);
        expect(agent.results).toHaveLength(1);
        expect(agent.unexpected).toEqual([]);
    } finally {
        // Close the page first so the intentional server shutdown is not a
        // reconnect attempt and cannot reach any other loopback service.
        await page.close();
        await agent.close();
    }
});
