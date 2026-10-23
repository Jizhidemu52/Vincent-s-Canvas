import type { BrowserContext, Locator, Page, Route } from "@playwright/test";
import { test, expect, type MockCanvasApi } from "./fixtures";

const VALID_ASSET = "90000000-0000-4000-8000-000000000001";
const tasks = [
    { id: "uncertain-attach", requestId: "supplier-timeout-with-original-upstream-id", displayName: "设计师甲", modelName: "测试图像模型", operationType: "image_generation", credits: 20, upstreamTaskId: null, failureReason: "供应商已接收，响应超时", resultUrls: [], canAttachUpstream: true, billingStatus: "reserved" },
    { id: "uncertain-terminal", requestId: "provider-result-reconciliation-".repeat(4), displayName: "设计师乙", modelName: "测试视频模型", operationType: "video_generation", credits: 60, upstreamTaskId: "provider-original-42", failureReason: "结果状态待核查", resultUrls: [], canAttachUpstream: false, billingStatus: "reserved" },
];

class AdminApi {
    listReads = 0;
    resolutions: Array<{ path: string; body: any }> = [];
    holdResolution = false;
    private held: Route[] = [];
    async attach(context: BrowserContext) {
        await context.route("**/api/auth/methods", route => this.json(route, { password: true, wecom: false, oa: false }));
        await context.route("**/api/admin/**", async route => {
            const request = route.request(), path = new URL(request.url()).pathname;
            if (path === "/api/admin/task-reconciliation" && request.method() === "GET") {
                this.listReads++;
                return this.json(route, { code: 0, data: { tasks, chats: [{ id: "chat-ledger", requestId: "chat-request-1", displayName: "设计师丙", modelName: "测试对话模型", credits: 5, createdAt: "2026-10-20T08:00:00Z" }], minimumChatAgeMinutes: 30 } });
            }
            if (path.startsWith("/api/admin/task-reconciliation/") && request.method() === "POST") {
                const body = request.postDataJSON(); this.resolutions.push({ path, body });
                if (this.holdResolution) { this.held.push(route); return; }
                if (body.decision === "confirmed_success" && !body.resultAssetIds?.includes(VALID_ASSET)) return this.json(route, { code: 400, msg: "必须提交属于原员工且媒体类型有效的结果素材" }, 400);
                return this.json(route, { code: 0, data: { status: "success" } });
            }
            if (path === "/api/admin/accounts") return this.json(route, { users: [], totalUsedCredits: 0 });
            if (path === "/api/admin/departments") return this.json(route, { departments: [] });
            if (path === "/api/admin/audit-logs") return this.json(route, { auditLogs: [] });
            if (path === "/api/admin/credit-policy") return this.json(route, { creditsEnabled: false, updatedAt: null });
            if (path === "/api/admin/history") return this.json(route, { history: [], total: 0, totalCredits: 0, totalRmbCost: 0, nextCursor: null, hasMore: false });
            if (path === "/api/admin/tasks") return this.json(route, { tasks: [], nextCursor: null, hasMore: false });
            if (path === "/api/admin/tasks/batches") return this.json(route, { batches: [], nextCursor: null, hasMore: false });
            return route.fallback();
        });
    }
    async failHeld() {
        this.holdResolution = false;
        for (const route of this.held.splice(0)) await this.json(route, { code: 500, msg: "模拟核查暂不可用，请保留证据并重试" }, 500);
    }
    private json(route: Route, value: unknown, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) }); }
}

async function openTaskManagement(page: Page, context: BrowserContext, api: MockCanvasApi) {
    api.role = "super_admin";
    const admin = new AdminApi(); await admin.attach(context);
    await page.goto("/admin");
    await page.getByRole("link", { name: "批量任务", exact: true }).click();
    const panel = page.getByRole("region", { name: "待核查结算" });
    await expect(panel.getByRole("button", { name: "核查任务" })).toHaveCount(2);
    return { admin, panel };
}

async function selectDecision(dialog: Locator, label: string) {
    await dialog.getByLabel("已核实结论", { exact: true }).click();
    await dialog.page().getByText(label, { exact: true }).click();
}

test("超级管理员核查必填证据，500保留表单并防止重复提交，成功素材由API验证", async ({ page, context, api }) => {
    const { admin, panel } = await openTaskManagement(page, context, api);
    await panel.getByRole("button", { name: "核查任务" }).first().click();
    const dialog = page.getByRole("dialog", { name: "核查原任务并结案" });
    const save = dialog.getByRole("button", { name: "保存核查结论" });
    await save.click();
    await expect(dialog.getByText("请选择核实后的结论")).toBeVisible();
    await expect(dialog.getByLabel("核查理由", { exact: true })).toHaveAttribute("aria-invalid", "true");
    expect(admin.resolutions).toHaveLength(0);
    await selectDecision(dialog, "已确认成功：交付结果并结算");
    await dialog.getByLabel("核查理由", { exact: true }).fill("供应商账单已人工核对");
    await save.click();
    await expect(dialog.getByLabel("供应商工单 / 账单 / 核查记录编号", { exact: true })).toHaveAttribute("aria-invalid", "true");
    expect(admin.resolutions).toHaveLength(0);
    await dialog.getByLabel("供应商工单 / 账单 / 核查记录编号", { exact: true }).fill("TICKET-2026-001");
    const readsBefore = admin.listReads;
    admin.holdResolution = true;
    await save.dblclick();
    await expect.poll(() => admin.resolutions.length).toBe(1);
    await expect(save).toHaveClass(/ant-btn-loading/);
    await admin.failHeld();
    await expect(page.getByText("模拟核查暂不可用，请保留证据并重试")).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("核查理由", { exact: true })).toHaveValue("供应商账单已人工核对");
    await expect.poll(() => admin.listReads).toBeGreaterThan(readsBefore);
    expect(admin.resolutions).toHaveLength(1);
    await save.click();
    await expect(page.getByText("必须提交属于原员工且媒体类型有效的结果素材")).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(admin.resolutions[1].body.resultAssetIds).toBeUndefined();
    await dialog.getByLabel("结果素材 UUID（逗号或换行分隔）", { exact: true }).fill(VALID_ASSET);
    await save.click();
    await expect(dialog).not.toBeVisible();
    expect(admin.resolutions).toHaveLength(3);
    expect(admin.resolutions[2].body).toMatchObject({ decision: "confirmed_success", resultAssetIds: [VALID_ASSET], reason: "供应商账单已人工核对", evidenceReference: "TICKET-2026-001" });
});

test("仅允许恢复的任务显示原上游编号选项，窄屏核查面板与弹窗不溢出", async ({ page, context, api }, testInfo) => {
    const { panel } = await openTaskManagement(page, context, api);
    await panel.getByRole("button", { name: "核查任务" }).first().click();
    const dialog = page.getByRole("dialog", { name: "核查原任务并结案" });
    await selectDecision(dialog, "按原上游编号恢复查询，不重新生成");
    await expect(dialog.getByLabel("原上游任务编号", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: /返\s*回/ }).click();
    await panel.getByRole("button", { name: "核查任务" }).nth(1).click();
    await dialog.getByLabel("已核实结论", { exact: true }).click();
    await expect(page.getByText("按原上游编号恢复查询，不重新生成", { exact: true })).not.toBeVisible();
    await page.keyboard.press("Escape");
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await expect(dialog).toBeVisible();
        const bounds = await dialog.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`reconciliation-${viewport.width}.png`), fullPage: true });
    }
    await dialog.getByRole("button", { name: /返\s*回/ }).click();
    await expect(dialog).not.toBeVisible();
    const bounds = await panel.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("reconciliation-panel-390.png"), fullPage: true });
});

test("部门管理员没有核查或批量任务入口，直接链接也不加载核查接口", async ({ page, context, api }) => {
    api.role = "department_admin";
    const admin = new AdminApi(); await admin.attach(context);
    await page.goto("/admin?tab=batch");
    await expect(page.getByRole("link", { name: "账号额度", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "批量任务", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "待核查结算" })).toHaveCount(0);
    expect(admin.listReads).toBe(0);
    expect(admin.resolutions).toHaveLength(0);
});
