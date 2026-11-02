import { test, expect, newCanvas } from "./fixtures";

test("new text-only canvas saves to cloud without requiring an image upload", async ({ page, api }) => {
    const id = await newCanvas(page);
    await page.getByRole("button", { name: "文本", exact: true }).click();
    await expect.poll(async () => {
        const state = await page.evaluate(async () => {
            const { useCanvasStore } = await import("/src/stores/canvas/use-canvas-store.ts");
            const state = useCanvasStore.getState();
            return { status: state.cloudStatus, error: state.cloudError };
        });
        if (state.error) throw new Error(JSON.stringify(state));
        return api.document(id)?.nodes.length;
    }).toBe(1);
});
