import { expect, fixturePng, test } from "./fixtures";

for (const mode of ["new", "selected", "narrow", "disabled", "multiple"] as const)
    test("tryout dock uses the visible target: " + mode, async ({ page, api }, info) => {
        const project = "ba000000-0000-4000-8000-000000000097",
            asset = "ba000000-0000-4000-8000-000000000098",
            now = new Date().toISOString();
        const product = { id: "dock-product", type: "image", title: "针织帽", width: 185, height: 140, position: { x: 240, y: 155 }, metadata: { serverAssetId: asset, status: "success" } };
        api.assetBytes.set(asset, fixturePng(110));
        api.assets.set(asset, { id: asset, ownerUserId: "00000000-0000-4000-8000-000000000099", kind: "image", status: "ready", mimeType: "image/png", contentUrl: "/api/assets/" + asset + "/content" });
        const nodes = mode === "multiple" ? [product, { ...product, id: "dock-other", title: "另一件", position: { x: 520, y: 155 } }] : [product];
        api.documents.set(project, {
            id: project,
            revision: 1,
            deleted: false,
            updatedAt: now,
            document: {
                id: project,
                title: "输入条测试",
                createdAt: now,
                updatedAt: now,
                nodes,
                connections: [],
                groups: [],
                viewport: { x: 0, y: 0, k: 1 },
                backgroundMode: "dots",
                showImageInfo: false,
                chatSessions: [],
                activeChatId: null,
                history: { past: [], future: [] },
            },
        });
        if (mode === "disabled") api.disabledModules.add("canvas-tryout");
        if (mode === "narrow") await page.setViewportSize({ width: 390, height: 844 });
        await page.goto("/canvas/" + project);
        const dock = page.getByRole("region", { name: "试款输入条" }),
            input = dock.getByRole("textbox", { name: "设计要求" }),
            more = dock.getByRole("button", { name: "更多设置" });
        const original = page.locator('[data-node-id="dock-product"]').first();
        await expect(original).toBeVisible();
        if (mode === "disabled") {
            await expect(dock).toHaveCount(0);
            expect(api.submissions).toHaveLength(0);
            return;
        }
        if (mode === "multiple") {
            await original.click({ position: { x: 50, y: 35 } });
            await page.keyboard.press("Control+a");
            await input.fill("测试多选");
            await expect(dock.getByRole("button", { name: "生成 1 张" })).toBeDisabled();
            await input.press("Enter");
            expect(api.submissions).toHaveLength(0);
            return;
        }
        if (mode === "selected") await original.click({ position: { x: 50, y: 35 } });
        await expect(dock.getByText(mode === "selected" ? "改这件：针织帽" : "生成新产品", { exact: true })).toBeVisible();
        await input.fill("请将帽檐改为深蓝色");
        if (mode === "selected") await expect(page.getByPlaceholder("描述要生成的图片内容")).not.toBeVisible();
        if (mode === "narrow") await dock.getByRole("button", { name: "生成设置", exact: true }).click();
        await more.click();
        await expect(more).toHaveAttribute("aria-expanded", "true");
        await more.click();
        await expect(input).toHaveValue("请将帽檐改为深蓝色");
        await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
        expect(api.submissions).toHaveLength(0);
        await page.screenshot({ path: info.outputPath("prompt-dock-" + mode + ".png") });
        if (mode === "narrow") {
            const box = await dock.boundingBox();
            expect(box!.x).toBeGreaterThanOrEqual(0);
            expect(box!.x + box!.width).toBeLessThanOrEqual(391);
        }
        await input.press("Enter");
        await expect.poll(() => api.submissions.length).toBe(1);
        expect(api.submissions[0]).toMatchObject({ operationType: mode === "selected" ? "inpaint" : "image_generation" });
        expect(api.submissions[0].prompt).toContain("请将帽檐改为深蓝色");
        if (mode === "selected") expect(api.submissions[0].sourceUrls).toEqual(["/api/assets/" + asset + "/content"]);
        else expect(api.submissions[0].sourceUrls ?? []).toEqual([]);
    });
