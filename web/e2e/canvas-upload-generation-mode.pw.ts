import { test, expect, newCanvas, uploadImage } from "./fixtures";

for (const clearReference of [false, true]) {
    test(`toolbar upload ${clearReference ? "cleared reference generates a new image" : "retained reference edits the image"}`, async ({ page, api }) => {
        const id = await newCanvas(page);
        await uploadImage(page, "mode-reference.png");
        await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
        const original = structuredClone(api.document(id)!.nodes[0]);
        const panel = page.getByTestId("canvas-quick-generate-panel");
        if (!await panel.isVisible()) await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
        const references = panel.getByRole("region", { name: "已选参考图", exact: true });
        await expect(references.getByRole("button", { name: /^移除参考图 / })).toHaveCount(1);
        if (clearReference) {
            await references.getByRole("button", { name: "清空", exact: true }).click();
            await expect(references).toHaveCount(0);
        }
        await panel.getByRole("textbox", { name: "描述图像", exact: true }).fill("Draw a simple blue fabric square.");
        await panel.locator("button.cw-generate-button").click();
        await expect.poll(() => api.submissions.length).toBe(1);
        expect(api.submissions[0]).toMatchObject({ operationType: clearReference ? "image_generation" : "inpaint" });
        expect(api.submissions[0].sourceUrls).toHaveLength(clearReference ? 0 : 1);
        expect(api.document(id)!.nodes.find((node: { id: string }) => node.id === original.id)).toEqual(original);
        expect(api.batchSubmissions).toHaveLength(0);
    });
}
