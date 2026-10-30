import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { inspectRenderedPerformanceImages, openPerformanceScene, preparePerformanceScene, PROJECT_ID } from "./canvas-performance-fixture";
import { createCanvasPerformanceTracker } from "../src/lib/canvas/canvas-performance-metrics";
import { toolDefinitions } from "../../shared/feature-catalog";

const variant = process.env.CANVAS_INPUT_VARIANT || "candidate";
const percentile = (values: number[]) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * .95) - 1)] || 0;

async function measureTyping(page: Page, input: Locator, text: string) {
    await input.fill("");
    await input.focus();
    await input.evaluate(element => {
        const metrics = { delays: [] as number[], frames: [] as number[], active: true };
        (window as any).__inputMeasurement = metrics;
        const onInput = () => { const start = performance.now(); requestAnimationFrame(() => metrics.delays.push(performance.now() - start)); };
        element.addEventListener("input", onInput);
        (window as any).__stopInputMeasurement = () => { metrics.active = false; element.removeEventListener("input", onInput); };
        let previous: number | undefined;
        const frame = (now: number) => { if (previous !== undefined) metrics.frames.push(now - previous); previous = now; if (metrics.active) requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
    });
    await input.pressSequentially(text, { delay: 5 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const samples = await page.evaluate(() => { (window as any).__stopInputMeasurement(); const { delays, frames } = (window as any).__inputMeasurement; return { delays, frames }; });
    expect(samples.delays.length).toBe(text.length);
    const tracker = createCanvasPerformanceTracker();
    tracker.start("typing", 0); samples.frames.forEach(ms => tracker.frame(ms));
    return { inputEvents: samples.delays.length, nextFrameP95Ms: percentile(samples.delays), nextFrameMaxMs: Math.max(...samples.delays),
        frames: tracker.finish(0, { totalNodes: 500, visibleNodes: await page.locator("[data-node-id]").count(), totalConnections: 100, visibleConnections: 0 }) };
}

test("500 节点下搜索、长对话与配置输入的前后测量及最新值执行", async ({ page, context, api }, info) => {
    test.skip(!process.env.CANVAS_INPUT_DIST, "前后输入测量必须指定正式构建；使用 canvas-input-v2.config.ts");
    const scene = await preparePerformanceScene(context, api, new URL(info.project.use.baseURL!).origin);
    const doc = api.document(PROJECT_ID)!;
    const config = doc.nodes[1];
    Object.assign(config, { type: "config", title: "配置输入验收", position: { x: 250, y: 20 }, width: 460, height: 700,
        metadata: { status: "idle", generationMode: "image", model: "gpt-image-2", composerContent: "基准提示词", configImageInputMode: "combined" } });
    // Reference filtering uses 100 real connected image records. All content is synthetic.
    doc.connections = doc.nodes.filter((node: any) => node.type === "image").map((node: any, index: number) => ({ id: `input-link-${index}`, fromNodeId: node.id, toNodeId: config.id }));
    doc.chatSessions = [{ id: "input-session", title: "合成输入基准", createdAt: doc.createdAt, updatedAt: doc.updatedAt,
        messages: Array.from({ length: 80 }, (_, index) => ({ id: `input-message-${index}`, role: index % 2 ? "assistant" : "user", text: `第${index}条合成对话。${"面料纹理与版型开发建议。".repeat(100)}` })) }];
    doc.activeChatId = "input-session";
    const models = [
        { id: "input-image", modelId: "gpt-image-2", name: "隔离图片模型", protocol: "openai", capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 },
        { id: "input-chat", modelId: "input-chat", name: "隔离对话模型", protocol: "openai", capabilities: ["chat"], creditCost: 0, rmbCost: 0 },
    ];
    await context.route("**/api/models", route => route.fulfill({ json: { models, prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: /chat|text|agent/.test(tool.toolKey) ? "input-chat" : "input-image", configurationVersion: 1 })) } }));
    await context.route("**/api/generation-capabilities?*", route => route.fulfill({ json: { models: [] } }));
    const chatRequests: unknown[] = [];
    await context.route("**/api/chat/responses", route => { chatRequests.push(route.request().postDataJSON()); return route.fulfill({ json: { content: "已收到最新输入（隔离模拟回复）", toolCalls: [] } }); });
    await openPerformanceScene(page);
    // The config card contains offscreen lazy reference thumbnails. Sample the
    // actual image nodes without forcing those optional previews to decode.
    const renderedImages = await inspectRenderedPerformanceImages(page, '[data-node-id]:not([data-node-id="performance-node-1"]) img');
    expect(renderedImages.length).toBeGreaterThan(0);
    const fixtureHashes = new Set([...scene.imageHashes.values()].flatMap(value => [value.original, value.thumbnail]));
    for (const image of renderedImages) {
        // Config reference thumbnails share the config card's node id; their
        // bytes must still come from this scene, never the default fixture PNG.
        expect(fixtureHashes.has(image.sha256), `Rendered image ${image.nodeId} belongs to the synthetic scene`).toBe(true);
    }
    const measurements: Record<string, Awaited<ReturnType<typeof measureTyping>>[]> = { command: [], config: [], assistant: [] };
    await page.keyboard.press("Control+k");
    const search = page.getByRole("combobox", { name: "搜索命令、节点和素材" });
    for (let round = 0; round < 3; round++) measurements.command.push(await measureTyping(page, search, "performance input latency measurement 0123456789"));
    // No sleep for deferred results before Enter: must execute the new query.
    await search.fill("配置输入验收"); await search.press("Enter");
    await expect(page.getByRole("dialog", { name: "命令与搜索" })).toBeHidden();
    const configNode = page.locator(`[data-node-id="${config.id}"]`);
    await expect(configNode).toHaveAttribute("aria-label", /已选择/);
    const composer = configNode.getByRole("textbox", { name: "提示词", exact: true });
    for (let round = 0; round < 3; round++) {
        measurements.config.push(await measureTyping(page, composer, "fresh prompt typing 0123456789 abcdefghijklmnop"));
        await expect(composer).toHaveText("fresh prompt typing 0123456789 abcdefghijklmnop");
    }
    // Verify deferred mention rendering cannot insert a previous query's image.
    await composer.fill("@"); await composer.pressSequentially("100"); await composer.press("Enter");
    await expect(composer.locator('[data-reference-node-id="performance-node-499"]')).toHaveCount(1);
    await composer.fill("最新中文配置内容必须完整保留"); await composer.press("Tab");
    await expect.poll(() => api.document(PROJECT_ID)?.nodes.find((node: any) => node.id === config.id)?.metadata.composerContent).toBe("最新中文配置内容必须完整保留");
    await page.getByRole("tab", { name: "对话", exact: true }).first().click();
    const panel = page.locator(".cw-agent-panel");
    const chat = panel.getByPlaceholder("直接问当前画布上的内容…");
    await expect(chat).toBeEnabled();
    await expect(panel.getByText(/^第79条合成对话。/)).toBeVisible();
    for (let round = 0; round < 3; round++) measurements.assistant.push(await measureTyping(page, chat, "explain current canvas without generating 0123456789"));
    const lastPrompt = "只回答：刚输入的最新内容，不生成图片";
    await chat.fill(lastPrompt); await chat.press("Enter");
    await expect(panel.getByText("已收到最新输入（隔离模拟回复）", { exact: true })).toBeVisible();
    expect(chatRequests).toHaveLength(1); expect(JSON.stringify(chatRequests[0])).toContain(lastPrompt);
    expect(api.submissions).toHaveLength(0);
    const dist = resolve(process.env.CANVAS_INPUT_DIST || "../output/canvas-v2-candidate-web");
    const report = { variant, buildIndexSha256: createHash("sha256").update(await readFile(resolve(dist, "index.html"))).digest("hex"),
        scene: { nodes: 500, images: 100, conversationMessages: 80, renderedMessageWindow: 80, inputSamplesPerScene: 3 },
        renderedImages, metric: "input-event to next requestAnimationFrame (not INP); frame tracker covers typing only", measurements };
    await mkdir(resolve("../output/canvas-input-v2"), { recursive: true });
    await writeFile(resolve(`../output/canvas-input-v2/${variant}.json`), JSON.stringify(report, null, 2));
    await info.attach("input-timings", { body: JSON.stringify(report), contentType: "application/json" });
    await page.screenshot({ path: info.outputPath("assistant-1800.png") });
});

test("报告一键复制只含汇总，窄屏与深浅主题均可操作", async ({ page, context, api }, info) => {
    test.skip(variant === "baseline", "复制按钮是本轮新增功能");
    api.role = "super_admin";
    await preparePerformanceScene(context, api, new URL(info.project.use.baseURL!).origin);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openPerformanceScene(page);
    const node = page.locator('[data-node-id="performance-node-0"]');
    // Tab is exercised from the real focus order, not only via element.focus().
    await node.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
    await expect(node).toBeFocused();
    const before = api.document(PROJECT_ID)!.nodes[0].position.x;
    await node.press("ArrowRight");
    await expect.poll(() => api.document(PROJECT_ID)!.nodes[0].position.x).toBe(before + 1);
    await node.press("Enter");
    const editor = node.locator("textarea:not([placeholder])");
    await editor.fill("私密画布内容不得出现在报告"); await editor.press("Escape");
    const box = await node.boundingBox();
    await page.mouse.move(box!.x + 30, box!.y + 15); await page.mouse.down(); await page.mouse.move(box!.x + 90, box!.y + 45, { steps: 20 }); await page.mouse.up();
    await page.getByLabel("本页体验数据", { exact: true }).click();
    // The product publishes after its interaction-end debounce. Wait for that
    // observable state rather than copying before the first sample exists.
    await expect(page.getByTestId("canvas-task-feedback").locator("dl")).toContainText(/最近 FPS · P95\s*[1-9][\d.]*\s*·\s*[1-9][\d.]* ms/);
    const copy = page.getByRole("button", { name: "复制体验报告", exact: true });
    await copy.click();
    const report = await page.evaluate(() => navigator.clipboard.readText());
    expect(report).toContain("总计 500"); expect(report).toContain("P95："); expect(report).not.toContain("私密画布内容"); expect(report).not.toContain(PROJECT_ID); expect(report).not.toContain("http");
    await page.screenshot({ path: info.outputPath("report-light.png") });
    await page.keyboard.press("Control+k");
    const search = page.getByRole("combobox", { name: "搜索命令、节点和素材" });
    await search.fill("切换主题"); await search.press("Enter");
    await expect(page.locator("main.cw-workspace")).toHaveAttribute("data-theme", "dark");
    await page.setViewportSize({ width: 900, height: 700 });
    await expect(copy).toBeVisible();
    const bounds = await copy.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(900);
    await copy.click(); await expect(page.getByText("体验报告已复制（不含画布内容）", { exact: true }).last()).toBeVisible();
    await page.screenshot({ path: info.outputPath("report-dark-900.png") });
    expect(api.submissions).toHaveLength(0);
});

test("引用弹层按需加载，加载中输入和键盘选择不中断", async ({ page, context, api }, info) => {
    test.skip(!process.env.CANVAS_INPUT_DIST || variant === "baseline", "仅验证本轮正式构建的按需加载资源");
    await preparePerformanceScene(context, api, new URL(info.project.use.baseURL!).origin);
    const doc = api.document(PROJECT_ID)!;
    doc.connections = doc.nodes.filter((node: any) => node.type === "image").map((node: any, index: number) => ({
        id: `mention-link-${index}`, fromNodeId: node.id, toNodeId: "performance-node-0",
    }));
    let requested = false;
    let release!: () => void;
    const loading = new Promise<void>(resolve => { release = resolve; });
    await context.route("**/assets/canvas-resource-mention-menu-*.js", async route => {
        requested = true;
        await loading;
        await route.continue();
    });
    try {
        await openPerformanceScene(page);
        expect(requested).toBe(false);
        const node = page.locator('[data-node-id="performance-node-0"]');
        await node.focus(); await node.press("Enter");
        const editor = node.locator("textarea:not([placeholder])");
        await editor.fill("@");
        await expect.poll(() => requested).toBe(true);
        await expect(editor).toBeVisible();
        await editor.pressSequentially("100"); await editor.press("Enter");
        await expect(editor).toHaveValue("图片100 ");
        release();
        await editor.fill("@1");
        const menu = page.locator('[data-canvas-resource-mention-menu="true"]');
        await expect(menu).toBeVisible();
        await menu.getByRole("button").filter({ has: page.getByText("图片1", { exact: true }) }).click({ timeout: 15_000 });
        await expect(editor).toHaveValue("图片1 ");
        await expect(editor).toBeFocused();
        await editor.press("Escape");
        await expect.poll(() => api.document(PROJECT_ID)?.nodes[0].metadata.content).toBe("图片1 ");
        expect(api.submissions).toHaveLength(0);
    } finally {
        release();
    }
});
