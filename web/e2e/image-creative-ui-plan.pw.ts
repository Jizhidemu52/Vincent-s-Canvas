import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect, fixturePng, type MockCanvasApi } from "./fixtures";

const active = (page: Page) => page.getByRole("tabpanel");
const taskTabs = (page: Page) => page.getByRole("tablist", { name: "任务列表", exact: true }).getByRole("tab");
const output = resolve(import.meta.dirname, "../../output/ui-plan-20261112/image-creative");

async function visibleAction(page: Page, button: Locator) {
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

async function imageDigest(image: Locator) {
    return image.evaluate(async (element: HTMLImageElement) => {
        if (!element.getAttribute("src")) return "";
        const bytes = await (await fetch(element.src)).arrayBuffer();
        return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
    });
}

function finish(api: MockCanvasApi, id: string) {
    const task = api.tasks.get(id)!;
    task.status = "success"; task.resultUrls = [`/api/assets/${id}/content`];
}

async function uploadFront(page: Page, name = "front.png", color = 80) {
    await active(page).getByLabel("上传服装正面图", { exact: true }).setInputFiles({ name, mimeType: "image/png", buffer: fixturePng(color) });
    await expect(active(page).getByRole("img", { name, exact: true })).toBeVisible();
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    test(`image and back-design layout keep actions visible at ${viewport.width}x${viewport.height}`, async ({ page, api }) => {
        await mkdir(output, { recursive: true });
        await page.setViewportSize(viewport);
        await page.goto("/image");
        const prompt = active(page).getByRole("textbox", { name: "图像提示词", exact: true });
        await expect(prompt).toBeEnabled();
        await expect(active(page).getByRole("button", { name: /一键优化提示词/ })).toHaveCount(0);
        const form = await active(page).locator(".generation-form").boundingBox();
        expect(form!.width).toBeGreaterThanOrEqual(430);
        expect(form!.width).toBeLessThanOrEqual(450);
        expect(await prompt.evaluate(element => getComputedStyle(element).fontSize)).toBe("14px");
        await visibleAction(page, active(page).getByRole("button", { name: "开始生成", exact: true }));
        await prompt.fill("LAYOUT_完整展示竖版服装");
        api.taskStatus = "processing";
        await active(page).getByRole("button", { name: "开始生成", exact: true }).click();
        await expect.poll(() => api.submissions.length).toBe(1);
        const taskId = [...api.tasks.keys()][0];
        const portrait = await page.evaluate(() => {
            const canvas = document.createElement("canvas"); canvas.width = 400; canvas.height = 600;
            const context = canvas.getContext("2d")!;
            const gradient = context.createLinearGradient(0, 0, 400, 600); gradient.addColorStop(0, "#ece8e0"); gradient.addColorStop(1, "#949086");
            context.fillStyle = gradient; context.fillRect(0, 0, 400, 600);
            context.fillStyle = "#34322f"; context.fillRect(80, 65, 240, 470);
            context.fillStyle = "#eee9df"; context.font = "20px sans-serif"; context.fillText("MOCK 2:3", 140, 300);
            return canvas.toDataURL("image/png").split(",")[1];
        });
        api.assetBytes.set(taskId, Buffer.from(portrait, "base64")); finish(api, taskId);
        const result = active(page).getByRole("img", { name: "生成结果 1", exact: true });
        await expect(result).toBeVisible();
        // Cached previews round their resized width to whole pixels.
        await expect.poll(() => result.evaluate((element: HTMLImageElement) => Math.abs(element.naturalHeight / element.naturalWidth - 1.5))).toBeLessThan(0.01);
        expect(await result.evaluate(element => getComputedStyle(element).objectFit)).toBe("contain");
        await page.screenshot({ path: resolve(output, `image-${viewport.width}x${viewport.height}.png`) });
        await active(page).getByRole("tab", { name: /历史记录/ }).click();
        await expect(active(page).locator(".image-history-panel")).toBeVisible();
        expect(api.submissions).toHaveLength(1);

        await page.goto("/creative/back-design");
        await uploadFront(page);
        await visibleAction(page, active(page).locator(".cs-generate"));
        api.taskStatus = "processing";
        await active(page).locator(".cs-generate").click();
        await expect.poll(() => api.submissions.length).toBe(2);
        await visibleAction(page, active(page).getByRole("button", { name: "新建任务，继续创作", exact: true }));
        await visibleAction(page, active(page).locator(".cs-generate"));
        await page.screenshot({ path: resolve(output, `back-design-running-${viewport.width}x${viewport.height}.png`) });
        await active(page).getByRole("button", { name: /^最近任务/ }).click();
        await expect(active(page).locator(".cs-history-item").first()).toBeEnabled();
        expect(api.submissions).toHaveLength(2);
    });
}

test("image history remains readable during a new run and keeps the new result separate", async ({ page, api }) => {
    await page.goto("/image");
    const prompt = active(page).getByRole("textbox", { name: "图像提示词", exact: true });
    await prompt.fill("历史旧图");
    await active(page).getByRole("button", { name: "开始生成", exact: true }).click();
    const result = active(page).getByRole("img", { name: "生成结果 1", exact: true });
    await expect(result).toBeVisible();
    await expect(result).toHaveAttribute("src", /^(blob:|data:|https?:)/);
    const oldDigest = await imageDigest(result);
    api.taskStatus = "processing";
    await prompt.fill("新任务独立结果");
    await active(page).getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(2);
    await active(page).getByRole("tab", { name: /历史记录/ }).click();
    await active(page).locator(".image-history-panel button").filter({ hasText: "历史旧图" }).click();
    await expect.poll(() => imageDigest(result)).toBe(oldDigest);
    await expect(prompt).toHaveValue("新任务独立结果");
    finish(api, [...api.tasks.keys()][1]);
    await expect(taskTabs(page).first()).toContainText("已完成");
    await expect.poll(() => imageDigest(result)).toBe(oldDigest);
    await active(page).getByRole("tab", { name: "本次结果", exact: true }).click();
    await expect.poll(() => imageDigest(result)).not.toBe(oldDigest);
    expect(api.submissions).toHaveLength(2);
});

test("back design can browse history and create B while A runs, with reverse completion isolated", async ({ page, api }) => {
    await page.goto("/creative/back-design");
    await uploadFront(page, "A-front.png", 50);
    await active(page).locator(".cs-generate").click();
    await expect(taskTabs(page).first()).toContainText("已完成");
    const result = active(page).locator(".cs-result-card .ant-image-img");
    const oldUrl = await result.getAttribute("src");
    api.taskStatus = "processing";
    await active(page).getByRole("radio", { name: "育克", exact: true }).check();
    await active(page).locator(".cs-generate").click();
    await expect.poll(() => api.submissions.length).toBe(2);
    const aId = [...api.tasks.keys()][1];
    await active(page).getByRole("button", { name: /^最近任务/ }).click();
    await active(page).locator(".cs-history-item").last().click();
    await expect(result).toHaveAttribute("src", oldUrl!);
    await active(page).getByRole("button", { name: "新建任务，继续创作", exact: true }).click();
    await expect(taskTabs(page)).toHaveCount(2);
    await uploadFront(page, "B-front.png", 210);
    await active(page).locator(".cs-generate").click();
    await expect.poll(() => api.submissions.length).toBe(3);
    const bId = [...api.tasks.keys()][2];
    finish(api, bId);
    await expect(taskTabs(page).nth(1)).toContainText("已完成");
    const bUrl = await result.getAttribute("src");
    await taskTabs(page).first().click();
    await expect(result).toHaveAttribute("src", oldUrl!);
    finish(api, aId);
    await expect(taskTabs(page).first()).toContainText("已完成");
    await expect(result).toHaveAttribute("src", oldUrl!);
    await active(page).getByRole("button", { name: "返回当前任务", exact: true }).click();
    await expect(result).not.toHaveAttribute("src", oldUrl!);
    await expect(result).not.toHaveAttribute("src", bUrl!);
    await taskTabs(page).nth(1).click();
    await expect(result).toHaveAttribute("src", bUrl!);
    await expect(active(page).getByRole("img", { name: "B-front.png", exact: true })).toBeVisible();
    expect(api.submissions).toHaveLength(3);
});
