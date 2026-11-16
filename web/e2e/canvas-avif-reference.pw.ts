import { AVIF_REFERENCE_UNSUPPORTED_MESSAGE } from "../../shared/generation-error";
import { test, expect, newCanvas } from "./fixtures";

const avif = Buffer.from("AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAbAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAAgAAAAIAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAjbWRhdAoGGBE/9oAgMhEXgAAASAAAAS2Sf/VWVbUVDA==", "base64");

test("AVIF remains uploaded while the project explains that the model cannot process it", async ({ page, api }, testInfo) => {
    const id = await newCanvas(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传素材", exact: true }).click();
    await (await chooser).setFiles({ name: "original.avif", mimeType: "image/avif", buffer: avif });
    await expect.poll(() => api.document(id)?.nodes.length).toBe(1);
    const original = structuredClone(api.document(id)!.nodes[0]);
    expect(original.title).toBe("original.avif");
    const stored = [...api.assets.values()].find(asset => asset.mimeType === "image/avif");
    expect(stored).toBeTruthy();
    expect(api.assetBytes.get(stored!.id)).toEqual(avif);
    const panel = page.getByTestId("canvas-quick-generate-panel");
    if (!await panel.isVisible()) await page.getByRole("button", { name: "展开创建面板", exact: true }).click();
    await panel.getByRole("textbox", { name: "描述图像", exact: true }).fill("Change the fabric color to red.");
    await expect(panel.getByRole("alert")).toHaveText(AVIF_REFERENCE_UNSUPPORTED_MESSAGE);
    await expect(panel.locator("button.cw-generate-button")).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("avif-upload-processing-notice.png"), fullPage: true });
    expect(api.document(id)!.nodes[0]).toEqual(original);
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});
