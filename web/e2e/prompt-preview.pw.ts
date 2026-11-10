import { test, expect, type Route } from "@playwright/test";

const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/e2e/prompt-preview.fixture.tsx"></script></body></html>`;
let posts: any[];
let previewPosts: any[];
let taskPosts: any[];
const fixedPrompt = '仅将图1主体改为蓝色。\n保留 6 颗纽扣及字样“春日 快乐”。\n图2只参考颜色；圈选标注仅指示修改区域。';
test.beforeEach(async ({ page }) => {
    posts = [];
    previewPosts = []; taskPosts = [];
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") return route.abort();
        if (url.pathname === "/__prompt-preview") return route.fulfill({ contentType: "text/html", body: fixture });
        if (url.pathname === "/api/models") return route.fulfill({ json: { models: [{ id: "preview-model", modelId: "preview-model", name: "测试模型", capabilities: ["generate", "edit"], imageParameterProfile: "standard", creditCost: 0, rmbCost: 0 }], tools: [], prices: [] } });
        if (url.pathname === "/api/assets/upload-request") return route.fulfill({ json: { assetId: "source", uploadUrl: null } });
        if (url.pathname === "/api/assets/source") return route.fulfill({ json: { asset: { id: "source", ownerUserId: "preview-employee", kind: "image", status: "ready" } } });
        if (url.pathname === "/api/assets/source/content" && route.request().method() === "HEAD") return route.fulfill({ contentType: "image/png", body: "" });
        if (/^\/api\/assets\/(?:ref-[01]|preview-markup)\/content$/.test(url.pathname)) return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64") });
        if (url.pathname === "/api/tasks/preview") {
            const input = route.request().postDataJSON(); previewPosts.push(input);
            return route.fulfill({ json: { preview: { prompt: fixedPrompt, promptInput: { ...input.promptInput, compilationId: `compiled-${input.requestId}` }, summaryZh: "保留结构、数量与字样，仅修改指定颜色。", nativeNegativePrompt: "额外纽扣、改变原有文字" } } });
        }
        if (url.pathname === "/api/tasks") { taskPosts.push(route.request().postDataJSON()); return route.fulfill({ json: { taskIds: ["fixture-task"] } }); }
        if (url.pathname === "/api/prompt-compilations") {
            const input = route.request().postDataJSON(); posts.push(input);
            return route.fulfill({ json: { compilation: { id: "compiled-preview", requestId: input.requestId, status: "success", prompt: `${input.promptInput.userText}\n仅修改指定区域。`, optimized: true, summaryZh: "只整理明确要求", ...(input.promptInput.userText.includes("不明确") ? { questions: ["需要修改哪一块区域？"] } : {}) } } });
        }
        if (url.pathname.startsWith("/api/")) return route.abort();
        return route.continue();
    });
    await page.goto("/__prompt-preview");
});

test("fixed-scene preview shows the compiled contract and cancellation submits no image task", async ({ page }, info) => {
    await page.getByRole("button", { name: "固定场景生成", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "生成前确认" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("保留结构、数量与字样，仅修改指定颜色。", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("实际发送文本", { exact: true })).toHaveText(fixedPrompt);
    await expect(dialog.getByText("模型原生排除参数", { exact: true })).toBeVisible();
    await expect(dialog.getByText("额外纽扣、改变原有文字", { exact: true })).toBeVisible();
    await expect(dialog.locator("ol li")).toHaveText(["图片1：以此图作为编辑原图。原图.png", "图片2：只参考此图的颜色。参考色.png", "圈选标注（不参与图片编号）圈选区域.png"]);
    expect(previewPosts).toHaveLength(1); expect(taskPosts).toHaveLength(0);
    await expect(page.locator(".ant-modal")).not.toHaveClass(/ant-zoom-(?:appear|enter)/);
    await page.screenshot({ path: info.outputPath("execution-light-desktop.png"), animations: "disabled" });
    await page.getByRole("button", { name: "取消，返回修改", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByTestId("fixed-status")).toContainText("已取消生成前确认");
    expect(taskPosts).toHaveLength(0);
});

test("fixed-scene mobile confirmation reuses compilationId and double confirmation submits once", async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "theme", exact: true }).click();
    await page.getByRole("button", { name: "将图片2前移", exact: true }).click();
    await page.getByRole("button", { name: "固定场景生成", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "生成前确认" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("ol li")).toHaveText(["图片1：只参考此图的颜色。参考色.png", "图片2：以此图作为编辑原图。原图.png", "圈选标注（不参与图片编号）圈选区域.png"]);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(page.locator(".ant-modal")).not.toHaveClass(/ant-zoom-(?:appear|enter)/);
    await page.screenshot({ path: info.outputPath("execution-dark-mobile.png"), animations: "disabled" });
    await page.getByRole("button", { name: "确认这份内容并生成", exact: true }).dblclick();
    await expect(page.getByTestId("fixed-status")).toHaveText("已提交图片任务");
    expect(previewPosts).toHaveLength(1); expect(taskPosts).toHaveLength(1);
    expect(taskPosts[0].promptInput).toEqual({ ...previewPosts[0].promptInput, compilationId: `compiled-${previewPosts[0].requestId}` });
    expect(taskPosts[0].sourceUrls).toEqual(previewPosts[0].sourceUrls);
    expect(taskPosts[0].parameters).toEqual(previewPosts[0].parameters);
    expect(posts).toHaveLength(0);
});

for (const change of ["account", "route"] as const) {
    test(`fixed-scene ${change} changes cancel confirmation without submitting`, async ({ page }) => {
        await page.getByRole("button", { name: "固定场景生成", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "生成前确认" });
        await expect(dialog).toBeVisible();
        await page.keyboard.press(change === "account" ? "Alt+a" : "Alt+r");
        await expect(dialog).not.toBeVisible();
        await expect(page.getByTestId("fixed-status")).toContainText("未提交图片任务");
        if (change === "route") await expect(page.getByTestId("fixture-route")).toHaveText("/changed-route");
        expect(previewPosts).toHaveLength(1); expect(taskPosts).toHaveLength(0);
    });
}

test("optimization is a comparison until confirmed; cancel retains exact original and no task is generated", async ({ page }, info) => {
    const input = page.getByRole("textbox", { name: "原始提示词" });
    const original = await input.inputValue();
    expect(posts).toHaveLength(0);
    await page.getByRole("button", { name: "一键优化提示词", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible(); await expect(dialog.locator("mark")).toContainText("仅修改指定区域。");
    await expect(input).toHaveValue(original);
    await expect(page.locator(".ant-modal")).not.toHaveClass(/ant-zoom-(?:appear|enter)/);
    await expect(page.locator(".ant-modal")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: info.outputPath("preview-light-desktop.png"), animations: "disabled" });
    await page.getByRole("button", { name: "取消，保留原文" }).click();
    await expect(dialog).not.toBeVisible(); await expect(input).toHaveValue(original);
    await page.getByRole("button", { name: "一键优化提示词", exact: true }).click();
    await page.getByRole("button", { name: "确认应用", exact: true }).click();
    await expect(input).toHaveValue(`${original}\n仅修改指定区域。`);
    expect(posts).toHaveLength(2);
});

test("image roles follow reorder and remain readable on narrow dark screens", async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "theme", exact: true }).click();
    await page.getByRole("combobox", { name: "图片2用途", exact: true }).click();
    await page.locator(".ant-select-item-option-content").filter({ hasText: /^只参考此图的图案。$/ }).click();
    await page.getByRole("button", { name: "将图片2前移", exact: true }).click();
    await expect(page.getByTestId("sent")).toContainText("图片1：只参考此图的图案。\n图片2：以此图作为编辑原图。");
    await page.getByRole("button", { name: "一键优化提示词", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(posts[0].promptInput.referenceRoles).toEqual(["只参考此图的图案。", "以此图作为编辑原图。"]);
    expect(await page.getByRole("dialog").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(page.locator(".ant-modal")).not.toHaveClass(/ant-zoom-(?:appear|enter)/);
    await expect(page.locator(".ant-modal")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: info.outputPath("preview-dark-mobile.png"), animations: "disabled" });
});

test("questions block application instead of turning ambiguity into a finished prompt", async ({ page }) => {
    await page.getByRole("textbox", { name: "原始提示词" }).fill("不明确的区域改成蓝色");
    await page.getByRole("button", { name: "一键优化提示词", exact: true }).click();
    await expect(page.getByRole("dialog").getByText("需要修改哪一块区域？")).toBeVisible();
    await expect(page.getByRole("button", { name: "确认应用", exact: true })).toBeDisabled();
});

test("a late optimization response never replaces a newer draft", async ({ page }) => {
    let pending: Route | undefined;
    await page.route("**/api/prompt-compilations", route => { pending = route; });
    const input = page.getByRole("textbox", { name: "原始提示词" });
    await page.getByRole("button", { name: "一键优化提示词", exact: true }).click();
    await expect.poll(() => Boolean(pending)).toBe(true);
    await input.fill("新要求：只改成红色，原有文字不变。");
    const submitted = pending!.request().postDataJSON();
    await pending!.fulfill({ json: { compilation: { id: "stale-compilation", requestId: submitted.requestId, status: "success", prompt: "旧的蓝色改写", optimized: true } } });
    await expect(page.getByText("原优化请求已完成，但输入或参考图已变化，未覆盖当前内容。", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(input).toHaveValue("新要求：只改成红色，原有文字不变。");
});
