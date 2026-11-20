import type { Page } from "@playwright/test";
import type { ImageReferenceItem } from "../src/types/image";
import { expect, IMAGE } from "./fixtures";
import { readWorkspaceRecords } from "./headless-workbench";

export async function expectPersistedReferenceOriginal(page: Page, name: string) {
    const image = page.getByRole("region", { name: "参考图", exact: true }).getByRole("img", { name, exact: true });
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute("data-loaded", "true");
    expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth > 0 && element.naturalHeight > 0)).toBe(true);
    const references = async () => (await readWorkspaceRecords<ImageReferenceItem[]>(page, "generation_drafts"))
        .filter(record => record.key.endsWith(":references") && Array.isArray(record.value))
        .flatMap(record => record.value).filter(reference => reference.name === name);
    await expect.poll(async () => (await references()).length).toBe(1);
    const [reference] = await references();
    expect(reference.storageKey).toBeTruthy();
    const stored = await page.evaluate(async key => {
        const { getImageBlob } = await import("/src/services/image-storage.ts");
        const blob = await getImageBlob(key);
        return blob ? [...new Uint8Array(await blob.arrayBuffer())] : null;
    }, reference.storageKey!);
    expect(stored).not.toBeNull();
    expect(Buffer.from(stored!).equals(IMAGE)).toBe(true);
}
