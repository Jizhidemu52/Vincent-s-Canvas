import { test, expect, type BrowserContext, type Route, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fixture, modelId } from "./fixture";
import { reportFixture } from "../usage-report-fixture";
import { USAGE_V2_ANALYSIS_SYSTEM, USAGE_V2_ANALYSIS_SYSTEM_VERSION } from "../../../shared/usage-report-v2";
const base = "/tests/usage-v2-browser/index.html?tab=usage-analysis&uFrom=2026-10-01&uTo=2026-10-07&uCompare=none";
const previewId = "30000000-0000-4000-8000-000000000001";
const output = resolve(import.meta.dirname, "../../../output/usage-analysis-browser");
async function setup(context: BrowserContext, extra?: (route: Route, url: URL) => Promise<boolean>) {
    const calls: Array<{ path: string; body: any }> = [],
        errors: string[] = [];
    for (const page of context.pages()) page.on("pageerror", (error) => errors.push(error.message));
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") return route.abort();
        if (!url.pathname.startsWith("/api/")) return route.continue();
        calls.push({ path: url.pathname, body: route.request().postDataJSON() });
        if (extra && (await extra(route, url))) return;
        const ok = (data: unknown) => route.fulfill({ json: { code: 0, data, msg: "ok" } });
        if (url.pathname.endsWith("/analysis-models"))
            return ok({ models: [{ id: modelId, name: "隔离验证文字模型" }] });
        if (url.pathname.endsWith("/analysis-preview-v2")) {
            const report = reportFixture(route.request().postDataJSON());
            const systemPrompt = USAGE_V2_ANALYSIS_SYSTEM,
                systemPromptVersion = USAGE_V2_ANALYSIS_SYSTEM_VERSION;
            const previewHash = createHash("sha256")
                .update(JSON.stringify({ source: "v2", systemPromptVersion, systemPrompt, content: report.content }))
                .digest("hex");
            return ok({
                ...report,
                source: "v2",
                previewId,
                previewHash,
                expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
                systemPromptVersion,
                systemPrompt,
                includesPromptSamples: false,
                sampleCount: 0,
            });
        }
        if (url.pathname.endsWith("/analyze"))
            return ok({
                source: "v2",
                analysisId: previewId,
                modelConfigId: modelId,
                content:
                    "一、事实：成功保存42张图片 [metrics.generatedImages.value]。\n二、缺口：时长不可用。\n三、有限推测：不足以推断因果。\n四、产品流程建议：核对采集覆盖。",
                createdAt: new Date().toISOString(),
            });
        try {
            return ok(fixture(url));
        } catch {
            return route.fulfill({ status: 501, json: { code: "UNMOCKED" } });
        }
    });
    return {
        calls,
        errors,
        previews: () => calls.filter((call) => call.path.endsWith("/analysis-preview-v2")),
        analyses: () => calls.filter((call) => call.path.endsWith("/analyze")),
    };
}
async function selectModel(page: Page) {
    await page.getByRole("button", { name: "加载 V2 文字模型", exact: true }).click();
    await page.getByLabel("V2 AI 文字模型").click();
    await page
        .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
        .filter({ hasText: "隔离验证文字模型" })
        .click();
}

test("V2 paid analysis requires selected model, exact frozen preview and explicit fee confirmation", async ({
    page,
    context,
}) => {
    const state = await setup(context);
    await page.goto(base);
    await expect(page.getByTestId("usage-v2-content")).toBeVisible();
    const preview = page.getByRole("button", { name: "预览 V2 AI 输入", exact: true });
    await expect(preview).toBeDisabled();
    expect(state.previews()).toHaveLength(0);
    expect(state.analyses()).toHaveLength(0);
    await page.getByRole("button", { name: "加载 V2 文字模型", exact: true }).click();
    await page.getByLabel("V2 AI 文字模型").click();
    await page
        .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
        .filter({ hasText: "隔离验证文字模型" })
        .click();
    await preview.click();
    const dialog = page.getByRole("dialog", { name: "确认 V2 AI 冻结输入" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/隔离验证文字模型/)).toBeVisible();
    const content = await dialog.getByTestId("usage-v2-ai-exact-input").innerText();
    expect(JSON.parse(content).metrics.generatedImages.value).toBe(42);
    await dialog.getByText("冻结的系统提示", { exact: true }).click();
    await expect(dialog.getByTestId("usage-v2-ai-system-input")).toHaveText(USAGE_V2_ANALYSIS_SYSTEM);
    expect(state.analyses()).toHaveLength(0);
    const confirm = dialog.getByRole("button", { name: "确认发送 V2 输入 · 可能付费", exact: true });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("确认已核对 V2 输入与费用").check();
    await page.screenshot({ path: resolve(output, "v2-ai-frozen-input.png"), animations: "disabled" });
    await confirm.click();
    await expect(page.getByTestId("usage-v2-ai-result")).toContainText("metrics.generatedImages.value");
    expect(state.analyses()).toHaveLength(1);
    expect(Object.keys(state.analyses()[0]!.body).sort()).toEqual([
        "confirm",
        "modelConfigId",
        "previewHash",
        "previewId",
        "source",
    ]);
    expect(state.analyses()[0]!.body).toMatchObject({ source: "v2", previewId, modelConfigId: modelId, confirm: true });
    expect(state.previews()).toHaveLength(1);
    expect(state.errors).toEqual([]);
});

test("draft, template and refresh changes suppress late V2 previews with no automatic regeneration", async ({
    page,
    context,
}) => {
    let release: (() => void) | undefined;
    const state = await setup(context, async (route, url) => {
        if (!url.pathname.endsWith("/analysis-preview-v2")) return false;
        await new Promise<void>((resolve) => {
            release = resolve;
        });
        await route
            .fulfill({ status: 503, json: { code: "SYNTHETIC_CANCELLED", msg: "PRIVATE_SECRET" } })
            .catch(() => undefined);
        return true;
    });
    for (const change of ["draft", "template", "refresh"]) {
        await page.goto(base.replace("uFrom=2026-10-01&uTo=2026-10-07", "uFrom=2026-10-05&uTo=2026-10-11"));
        await expect(page.getByTestId("usage-v2-content")).toBeVisible();
        await selectModel(page);
        release = undefined;
        await page.getByRole("button", { name: "预览 V2 AI 输入", exact: true }).click();
        await expect.poll(() => Boolean(release)).toBe(true);
        if (change === "draft") await page.getByLabel("分析开始日期").fill("2026-10-06");
        else if (change === "template") {
            await page.getByLabel("免费统计报告模板").click();
            await page
                .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
                .filter({ hasText: "周报 · 完整自然周" })
                .click();
        } else await page.getByRole("button", { name: "刷新读取", exact: true }).click();
        release?.();
        await expect(page.getByRole("dialog", { name: "确认 V2 AI 冻结输入" })).toHaveCount(0);
        await expect(page.getByTestId("usage-v2-ai-result")).toHaveCount(0);
    }
    expect(state.previews()).toHaveLength(3);
    expect(state.analyses()).toHaveLength(0);
    expect(state.errors).toEqual([]);
});

test("failed and cancelled V2 calls stay consumed in the UI and never resend or display late results", async ({
    page,
    context,
}) => {
    let mode = "fail",
        release: (() => void) | undefined;
    const state = await setup(context, async (route, url) => {
        if (!url.pathname.endsWith("/analyze")) return false;
        if (mode === "hold")
            await new Promise<void>((resolve) => {
                release = resolve;
            });
        await route
            .fulfill(
                mode === "fail"
                    ? { status: 502, json: { code: "USAGE_ANALYSIS_FAILED", msg: "PRIVATE_SECRET" } }
                    : {
                          json: {
                              code: 0,
                              data: {
                                  source: "v2",
                                  analysisId: previewId,
                                  modelConfigId: modelId,
                                  content: "LATE_RESULT_MUST_NOT_SHOW",
                                  createdAt: new Date().toISOString(),
                              },
                          },
                      },
            )
            .catch(() => undefined);
        return true;
    });
    await page.goto(base);
    await expect(page.getByTestId("usage-v2-content")).toBeVisible();
    await selectModel(page);
    const dialog = page.getByRole("dialog", { name: "确认 V2 AI 冻结输入" });
    const start = async () => {
        await page.getByRole("button", { name: "预览 V2 AI 输入", exact: true }).click();
        await expect(dialog).toBeVisible();
        await dialog.getByLabel("确认已核对 V2 输入与费用").check();
        await dialog.getByRole("button", { name: "确认发送 V2 输入 · 可能付费", exact: true }).click();
    };
    await start();
    await expect(page.getByText(/模型调用未获得可用结果/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "确认发送 V2 输入 · 可能付费", exact: true })).toBeDisabled();
    expect(state.analyses()).toHaveLength(1);
    await dialog.getByRole("button", { name: "取消 V2 预览", exact: true }).click();
    mode = "hold";
    await start();
    await expect.poll(() => Boolean(release)).toBe(true);
    await expect(dialog.getByRole("button", { name: "确认发送 V2 输入 · 可能付费", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "取消 V2 预览", exact: true }).click();
    release?.();
    await expect(page.getByText(/模型调用可能已发生或产生费用/)).toBeVisible();
    await expect(page.getByTestId("usage-v2-ai-result")).toHaveCount(0);
    await expect(page.getByText("LATE_RESULT_MUST_NOT_SHOW")).toHaveCount(0);
    expect(state.analyses()).toHaveLength(2);
    expect(state.errors).toEqual([]);
});
