import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { test, expect, IMAGE } from "./fixtures";
import { performanceRaster } from "./canvas-performance-fixture";

const projectId = "b3000000-0000-4000-8000-000000000001";
const keys = Array.from({ length: 24 }, (_, index) => `image:lazy-catalog-${index}`);
const original = performanceRaster(9, 1024, 768);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("local original reads are deferred until explicit storage-only selection and restored without scanning other images", async ({
    page,
    api,
}, info) => {
    await page.goto("/canvas");
    await expect(page.getByRole("button", { name: "新建画布", exact: true }).first()).toBeEnabled();
    await page.evaluate(
        async ({ keys, originalBytes, thumbnailBytes }) => {
            const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
            const originals = createWorkspaceStorage("image_files"),
                thumbnails = createWorkspaceStorage("image_thumbnails");
            const blob = new Blob([new Uint8Array(originalBytes)], { type: "image/png" });
            const thumbnail = new Blob([new Uint8Array(thumbnailBytes)], { type: "image/png" });
            for (const key of keys) {
                await originals.setItem(key, blob);
                await thumbnails.setItem(`thumbnail:v1:${key}:256`, thumbnail);
            }
        },
        { keys, originalBytes: [...original], thumbnailBytes: [...IMAGE] },
    );
    const nodes = keys.map((storageKey, index) => ({
        id: `lazy-node-${index}`,
        type: "image",
        title: `本地款式 ${index + 1}`,
        width: 128,
        height: 96,
        position: { x: (index % 6) * 150, y: Math.floor(index / 6) * 130 },
        metadata: {
            status: "success",
            ...(index === 7
                ? {}
                : { content: `/api/assets/b4000000-0000-4000-8000-${String(index).padStart(12, "0")}/content` }),
            storageKey,
            naturalWidth: 1024,
            naturalHeight: 768,
            bytes: original.length,
            mimeType: "image/png",
        },
    }));
    const saved = {
        id: projectId,
        title: "24 张本地原图读取验证",
        createdAt: "2026-11-20T00:00:00.000Z",
        updatedAt: "2026-11-20T00:00:00.000Z",
        nodes,
        connections: [],
        groups: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "dots",
        showImageInfo: false,
        viewport: { x: 80, y: 150, k: 0.5 },
        selectedNodeIds: [],
        history: { past: [], future: [] },
    };
    api.documents.set(projectId, {
        id: projectId,
        revision: 1,
        document: saved,
        deleted: false,
        updatedAt: saved.updatedAt,
    });
    await page.addInitScript(() => {
        const get = IDBObjectStore.prototype.get;
        (window as any).lazyOriginalReads = [];
        IDBObjectStore.prototype.get = function (key) {
            const request = get.call(this, key);
            if (this.name === "image_files" && String(key).startsWith("image:lazy-catalog-")) {
                const read = { key: String(key), bytes: 0 };
                (window as any).lazyOriginalReads.push(read);
                request.addEventListener("success", () => {
                    read.bytes = request.result?.size || 0;
                });
            }
            return request;
        };
    });
    const reads = () => page.evaluate(() => (window as any).lazyOriginalReads as Array<{ key: string; bytes: number }>);
    await page.goto(`/canvas/${projectId}`);
    await page.getByRole("button", { name: "打开设计讨论", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "设计讨论面板" });
    const composer = panel.getByRole("textbox", { name: "输入设计需求" });
    await expect(composer).toBeEnabled();
    await composer.fill("原件与原有参考必须保持不变");
    await expect(panel.getByRole("button", { name: "素材库选图", exact: true })).toBeEnabled();
    const initial = await reads();
    await writeFile(
        info.outputPath("initial-original-reads.json"),
        JSON.stringify(
            { nodes: keys.length, reads: initial, totalBytes: initial.reduce((sum, read) => sum + read.bytes, 0) },
            null,
            2,
        ),
    );
    await page.screenshot({ path: info.outputPath("closed-picker-original-reads.png"), animations: "disabled" });
    expect(initial).toEqual([]);

    await panel.getByRole("button", { name: "画布 / 素材选图", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "选择设计参考", exact: true });
    await expect(picker.getByRole("button", { name: /^选择图片：/ })).toHaveCount(keys.length);
    const chosen = picker.getByRole("button", { name: "选择图片：本地款式 8", exact: true });
    await expect(chosen.locator("img")).toHaveAttribute("data-loaded", "true");
    expect(await reads()).toEqual([]);
    await chosen.click();
    await picker.getByRole("button", { name: "使用这 1 张图片", exact: true }).click();
    await expect(panel.locator(".studio-reference img")).toHaveAttribute("data-loaded", "true");
    expect(await reads()).toEqual([{ key: keys[7], bytes: original.length }]);
    await expect(composer).toHaveValue("原件与原有参考必须保持不变");
    await panel.getByRole("button", { name: "查看参考图1原图", exact: true }).click();
    const preview = page.getByRole("dialog");
    const selectedBytes = await preview
        .locator("img")
        .evaluate(async (image) => [
            ...new Uint8Array(await (await fetch((image as HTMLImageElement).src)).arrayBuffer()),
        ]);
    expect(sha256(new Uint8Array(selectedBytes))).toBe(sha256(original));
    await page.keyboard.press("Escape");
    await panel.getByRole("button", { name: "收起讨论面板", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "打开设计讨论", exact: true }).click();
    await expect(composer).toHaveValue("原件与原有参考必须保持不变");
    await expect(panel.locator(".studio-reference img")).toHaveAttribute("data-loaded", "true");
    const restored = await reads();
    expect(restored).toEqual([{ key: keys[7], bytes: original.length }]);
    await page.screenshot({ path: info.outputPath("selected-original-restored-only.png"), animations: "disabled" });
    await writeFile(
        info.outputPath("verified-original-reads.json"),
        JSON.stringify(
            {
                nodes: keys.length,
                closedPickerOriginalReads: initial.length,
                pickerOriginalReads: 0,
                explicitSelectionOriginalReads: 1,
                reloadOriginalReads: restored.length,
                originalBytes: original.length,
                originalSha256: sha256(original),
                copiedOriginalSha256: sha256(new Uint8Array(selectedBytes)),
                taskSubmissions: api.submissions.length,
            },
            null,
            2,
        ),
    );
    expect(api.submissions).toEqual([]);
});
