import type { Page } from "@playwright/test";
import { test, expect, IMAGE } from "./fixtures";

const OWNER = "00000000-0000-4000-8000-000000000099";
const OTHER_OWNER = "00000000-0000-4000-8000-000000000098";
const REQUIREMENTS = ["目标产品：条纹针织连衣裙", "关键特征：保留圆领、条纹和羊毛质感"];
const prompt = (page: Page) => page.getByRole("textbox", { name: "图像提示词", exact: true });
const requirements = (page: Page) => page.getByRole("textbox", { name: "沿用设计要求", exact: true });
const submit = (page: Page) => page.getByRole("button", { name: "开始编辑", exact: true });
const referenceImages = (page: Page) => page.getByRole("region", { name: "参考图", exact: true }).locator("img");

/** Create the same durable handoff as the result action, using real original-byte storage. */
async function prepare(page: Page, name = "设计原图.png", lines = REQUIREMENTS) {
    return page.evaluate(async ({ base64, name, lines }) => {
        const { prepareDesignHandoff } = await import("/src/lib/design-handoff.ts");
        return prepareDesignHandoff("image-edit", { id: name, name, type: "image/png", dataUrl: `data:image/png;base64,${base64}` }, { version: 1, sourceScene: "style-to-sketch", requirements: lines });
    }, { base64: IMAGE.toString("base64"), name, lines });
}

async function saved(page: Page, href: string) {
    return page.evaluate(async href => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const token = new URL(href, location.href).searchParams.get("designToken")!;
        const drafts = createWorkspaceStorage("generation_drafts"), scope = `image-edit:design:${token}`;
        return {
            handoff: await createWorkspaceStorage("design_handoffs").getItem<any>(token),
            ready: await drafts.getItem(`${scope}:designReady`),
            prompt: await drafts.getItem(`${scope}:prompt`),
            references: await drafts.getItem<any[]>(`${scope}:references`),
            requirements: await drafts.getItem(`${scope}:carryoverRequirements`),
            ordinary: await drafts.getItem("image-edit:prompt"),
        };
    }, href);
}

test("handoff stays separate, suppresses query overrides, preserves edits across refresh and explicitly submits frozen requirements", async ({ page, api }) => {
    await page.goto("/image?tool=image-edit");
    await expect(page.getByText("正在恢复草稿…", { exact: true })).toHaveCount(0);
    await prompt(page).fill("原图片编辑草稿保持不变");
    const href = await prepare(page);
    await expect.poll(async () => (await saved(page, href)).ordinary).toBe("原图片编辑草稿保持不变");
    const originalHandoff = (await saved(page, href)).handoff;
    await page.goto(`${href}&prompt=不应带入&model=unexpected-model&sourceAssetId=unexpected-asset&reuseToken=unexpected-reuse`);
    await expect(requirements(page)).toHaveValue(REQUIREMENTS.join("\n"));
    await expect(prompt(page)).toHaveValue("");
    await expect(referenceImages(page)).toHaveCount(1);
    await expect(submit(page)).toBeDisabled();
    expect(api.submissions).toHaveLength(0);
    await prompt(page).fill("只调整袖口宽度");
    await requirements(page).fill("保留羊毛质感\n圆领和条纹保持不变");
    await expect.poll(async () => (await saved(page, href)).requirements).toEqual(["保留羊毛质感", "圆领和条纹保持不变"]);
    await page.reload();
    await expect(prompt(page)).toHaveValue("只调整袖口宽度");
    await expect(requirements(page)).toHaveValue("保留羊毛质感\n圆领和条纹保持不变");
    await expect(referenceImages(page)).toHaveCount(1);
    expect(api.submissions).toHaveLength(0);
    await page.getByRole("link", { name: "打开原图片编辑草稿", exact: true }).click();
    await expect(prompt(page)).toHaveValue("原图片编辑草稿保持不变");
    const second = await prepare(page, "第二款原图.png", ["目标产品：独立围巾"]);
    await page.goto(second);
    await expect(requirements(page)).toHaveValue("目标产品：独立围巾");
    await expect(prompt(page)).toHaveValue("");
    await prompt(page).fill("第二款修改不应串入第一款");
    await expect.poll(async () => (await saved(page, second)).prompt).toBe("第二款修改不应串入第一款");
    await page.goto(href);
    await expect(prompt(page)).toHaveValue("只调整袖口宽度");
    await expect(requirements(page)).toHaveValue("保留羊毛质感\n圆领和条纹保持不变");
    await submit(page).click();
    await expect(page.getByRole("button", { name: "放入画布", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(1);
    expect(api.submissions[0]).toMatchObject({ toolKey: "image-edit", operationType: "inpaint", promptInput: { scene: "free-optimize", mode: "edit", userText: "只调整袖口宽度", fields: { carryoverRequirements: ["保留羊毛质感", "圆领和条纹保持不变"] } } });
    expect(api.submissions[0].sourceUrls).toHaveLength(1);
    const uploadedId = api.submissions[0].sourceUrls[0].split("/")[3];
    expect(api.assetBytes.get(uploadedId)?.equals(IMAGE)).toBe(true);
    expect((await saved(page, href)).handoff).toEqual(originalHandoff);
    expect((await saved(page, href)).ordinary).toBe("原图片编辑草稿保持不变");
    await requirements(page).fill("尚未提交的下一款要求");
    await page.getByRole("button").filter({ has: page.getByRole("checkbox", { name: "选择记录：只调整袖口宽度", exact: true }) }).click();
    await page.getByRole("button", { name: "恢复为草稿继续改", exact: true }).click();
    await page.getByRole("button", { name: "确认恢复", exact: true }).click();
    await expect(requirements(page)).toHaveValue("保留羊毛质感\n圆领和条纹保持不变");
    await expect.poll(async () => (await saved(page, href)).requirements).toEqual(["保留羊毛质感", "圆领和条纹保持不变"]);
    await page.reload();
    await expect(requirements(page)).toHaveValue("保留羊毛质感\n圆领和条纹保持不变");
    expect(api.submissions).toHaveLength(1);
});

test("optimization carries the same fields and editing them invalidates a completed compilation", async ({ page, api }) => {
    const compilations: any[] = [];
    await page.route("**/api/prompt-compilations", route => {
        const input = route.request().postDataJSON(); compilations.push(input);
        return route.fulfill({ json: { compilation: { id: "10000000-0000-4000-8000-000000000088", requestId: input.requestId, status: "success", prompt: "Optimized cuff change only", optimized: true } } });
    });
    await page.goto("/image?tool=image-edit");
    await expect(prompt(page)).toBeVisible();
    const href = await prepare(page);
    await page.goto(href);
    await expect(requirements(page)).toHaveValue(REQUIREMENTS.join("\n"));
    await prompt(page).fill("调整袖口");
    await page.getByRole("button", { name: "一键优化提示词", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "核对提示词优化", exact: true });
    await expect(preview.locator("pre").nth(1)).toHaveText("Optimized cuff change only");
    await expect(prompt(page)).toHaveValue("调整袖口");
    expect(api.submissions).toHaveLength(0);
    await preview.getByRole("button", { name: "确认应用", exact: true }).click();
    await expect(preview).toBeHidden();
    await expect(prompt(page)).toHaveValue("Optimized cuff change only");
    expect(compilations).toHaveLength(1);
    expect(compilations[0].promptInput).toMatchObject({ scene: "free-optimize", mode: "edit", fields: { carryoverRequirements: REQUIREMENTS } });
    await requirements(page).fill("保留新确认的黑白条纹");
    await submit(page).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0].promptInput).toMatchObject({ userText: "Optimized cuff change only", fields: { carryoverRequirements: ["保留新确认的黑白条纹"] } });
    expect(api.submissions[0].promptInput.compilationId).toBeUndefined();
    expect(compilations).toHaveLength(1);
});

test("an optimization response cannot replace input after the carried requirements changed", async ({ page, api }) => {
    const waiting: Array<{ route: any; input: any }> = [];
    await page.route("**/api/prompt-compilations", route => { waiting.push({ route, input: route.request().postDataJSON() }); });
    await page.goto("/image?tool=image-edit");
    await expect(prompt(page)).toBeVisible();
    await page.goto(await prepare(page));
    await expect(requirements(page)).toHaveValue(REQUIREMENTS.join("\n"));
    await prompt(page).fill("本次袖口修改");
    await page.getByRole("button", { name: "一键优化提示词", exact: true }).click();
    await expect.poll(() => waiting.length).toBe(1);
    await requirements(page).fill("新的人工要求应优先保留");
    const original = waiting[0];
    expect(original.input.promptInput.fields.carryoverRequirements).toEqual(REQUIREMENTS);
    await original.route.fulfill({ json: { compilation: { id: "10000000-0000-4000-8000-000000000077", requestId: original.input.requestId, status: "success", prompt: "STALE OPTIMIZATION", optimized: true } } });
    await expect(page.getByText("原优化请求已完成，但输入或参考图已变化，未覆盖当前内容。", { exact: true })).toBeVisible();
    await expect(prompt(page)).toHaveValue("本次袖口修改");
    await expect(requirements(page)).toHaveValue("新的人工要求应优先保留");
    expect(api.submissions).toHaveLength(0);
});

test("limits block submission without truncation and clearing requirements remains explicit", async ({ page, api }) => {
    await page.goto("/image?tool=image-edit");
    await expect(prompt(page)).toBeVisible();
    await page.goto(await prepare(page));
    await expect(requirements(page)).toHaveValue(REQUIREMENTS.join("\n"));
    await prompt(page).fill("仅修改袖口");
    for (const value of [Array.from({ length: 13 }, (_, i) => `第${i + 1}条`).join("\n"), "长".repeat(801), Array(8).fill("长".repeat(800)).join("\n")]) {
        await requirements(page).fill(value);
        await expect(requirements(page)).toHaveValue(value);
        await expect(submit(page)).toBeDisabled();
        await expect(page.getByRole("button", { name: "一键优化提示词", exact: true })).toBeDisabled();
    }
    await requirements(page).fill("");
    await expect(submit(page)).toBeEnabled();
    await submit(page).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    expect(api.submissions[0].promptInput.fields.carryoverRequirements).toEqual([]);
});

test("a partial storage failure leaves no ready marker and retries initialization without submissions", async ({ page, api }) => {
    await page.goto("/image?tool=image-edit");
    await expect(prompt(page)).toBeVisible();
    const href = await prepare(page);
    await page.addInitScript(() => {
        (window as any).__failDesignWrite = true;
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, key) {
            if ((window as any).__failDesignWrite && String(key).startsWith("image-edit:design:") && String(key).endsWith(":carryoverRequirements")) throw new DOMException("Design draft storage full", "QuotaExceededError");
            return put.call(this, value, key!);
        };
    });
    await page.goto(href);
    await expect(page.getByRole("button", { name: "重新读取设计交接", exact: true })).toBeVisible();
    await expect(submit(page)).toBeDisabled();
    await expect(page.getByRole("button", { name: "上传图片", exact: true })).toBeDisabled();
    const failed = await saved(page, href);
    expect(failed.ready).toBeNull();
    expect(failed.handoff.brief.requirements).toEqual(REQUIREMENTS);
    // Even a programmatically delivered hidden file-input change cannot bypass the gate.
    await page.locator('input[type="file"]').setInputFiles({ name: "blocked.png", mimeType: "image/png", buffer: IMAGE });
    expect((await saved(page, href)).references).toEqual(failed.references);
    await page.evaluate(() => { (window as any).__failDesignWrite = false; });
    await page.getByRole("button", { name: "重新读取设计交接", exact: true }).click();
    await expect(requirements(page)).toHaveValue(REQUIREMENTS.join("\n"));
    await expect(referenceImages(page)).toHaveCount(1);
    expect((await saved(page, href)).ready).toBe(true);
    expect(api.submissions).toHaveLength(0);
});

test("corrupt initialized fields fail closed without replaying the source or crashing the page", async ({ page, api }) => {
    await page.goto("/image?tool=image-edit");
    await expect(prompt(page)).toBeVisible();
    const href = await prepare(page);
    await page.goto(href);
    await expect(requirements(page)).toHaveValue(REQUIREMENTS.join("\n"));
    await page.evaluate(async href => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const token = new URL(href, location.href).searchParams.get("designToken")!;
        await createWorkspaceStorage("generation_drafts").setItem(`image-edit:design:${token}:carryoverRequirements`, { invalid: true });
        await createWorkspaceStorage("generation_drafts").setItem(`image-edit:design:${token}:prompt`, { invalid: true });
    }, href);
    await page.reload();
    await expect(page.getByText("设计草稿暂时无法完整读取，请重试；不会重新覆盖已保存的编辑。", { exact: true })).toBeVisible();
    await expect(submit(page)).toBeDisabled();
    await page.getByRole("button", { name: "重新读取设计交接", exact: true }).click();
    await expect(submit(page)).toBeDisabled();
    expect((await saved(page, href)).requirements).toEqual({ invalid: true });
    expect((await saved(page, href)).handoff.brief.requirements).toEqual(REQUIREMENTS);
    expect(api.submissions).toHaveLength(0);
});

test("invalid and other-account tokens cannot read the original draft and unrelated tools ignore the token", async ({ page, api }) => {
    let currentOwner = OWNER;
    await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: currentOwner, username: "receiver", displayName: "隔离账号", role: "designer", status: "active", departmentId: null, mustChangePassword: false, creditBalance: 999 } } }));
    await page.goto("/image?tool=image-edit");
    await expect(prompt(page)).toBeVisible();
    const href = await prepare(page);
    await page.goto(href);
    await expect(requirements(page)).toHaveValue(REQUIREMENTS.join("\n"));
    await prompt(page).fill("只属于原账号");
    await expect.poll(async () => (await saved(page, href)).prompt).toBe("只属于原账号");
    currentOwner = OTHER_OWNER;
    await page.reload();
    await expect(page.getByRole("button", { name: "重新读取设计交接", exact: true })).toBeVisible();
    await expect(prompt(page)).toHaveValue("");
    await expect(requirements(page)).toHaveValue("");
    await expect(submit(page)).toBeDisabled();
    currentOwner = OWNER;
    await page.reload();
    await expect(prompt(page)).toHaveValue("只属于原账号");
    await expect(requirements(page)).toHaveValue(REQUIREMENTS.join("\n"));
    await page.goto("/image?tool=image-edit&designToken=..%2F..%2F&prompt=must-not-use");
    await expect(page.getByText("设计交接链接无效，请从原结果重新打开。", { exact: true })).toBeVisible();
    await expect(submit(page)).toBeDisabled();
    await page.goto("/image?designToken=not-for-this-tool&prompt=普通生成草稿");
    await expect(prompt(page)).toHaveValue("普通生成草稿");
    await expect(requirements(page)).toHaveCount(0);
    expect(api.submissions).toHaveLength(0);
});
