import { test, expect, IMAGE } from "./fixtures";
import type { Locator, Page, Route } from "@playwright/test";

async function dropFiles(target: Locator, names: string[], itemOnly = false) {
    return target.evaluate((element, input) => {
        const data = new DataTransfer();
        for (const name of input.names) data.items.add(new File([Uint8Array.from(input.bytes)], name, { type: "" }));
        if (input.itemOnly) Object.defineProperty(data, "files", { value: new DataTransfer().files });
        element.dispatchEvent(new DragEvent("dragenter", { dataTransfer: data, bubbles: true, cancelable: true }));
        const event = new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
    }, { bytes: [...IMAGE], names, itemOnly });
}
async function project(page: Page, button: string) {
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: button, exact: true }).click();
    const stream = await (await download).createReadStream();
    if (!stream) throw Error("Project download missing");
    const chunks: Buffer[] = []; for await (const part of stream) chunks.push(Buffer.from(part));
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const bytes = (src: string) => Buffer.from(src.split(",")[1]!, "base64");

test("local placement drops preserve base/artwork roles, original bytes and multiple images", async ({ page, api }) => {
    await page.goto("/creative/pattern-placement");
    await expect(page.getByRole("combobox", { name: "本地工程" })).toBeEnabled();
    await expect(page.locator("[data-layer-count]")).toHaveText("1 / 30");
    expect(await dropFiles(page.locator(".placement-canvas-wrap"), ["企业微信花型A", "企业微信花型B"], true)).toBe(true);
    await expect(page.locator("[data-layer-count]")).toHaveText("3 / 30");
    expect(await dropFiles(page.getByRole("button", { name: "替换服装底图", exact: true }), ["桌面底图.png"])).toBe(true);
    await expect(page.locator(".placement-base-name")).toHaveText("桌面底图.png");
    const exported = await project(page, "导出工程 JSON");
    expect(bytes(exported.base.src)).toEqual(IMAGE);
    expect(exported.layers).toHaveLength(3);
    for (const layer of exported.layers.slice(1)) expect(bytes(layer.src)).toEqual(IMAGE);
    expect(api.submissions).toHaveLength(0); expect(api.assetBytes.size).toBe(0);
});

test("local repeat accepts item-only WeCom images and exports original bytes without model calls", async ({ page, api }) => {
    await page.goto("/creative/pattern-repeat");
    await expect(page.getByRole("combobox", { name: "本地工程" })).toBeEnabled();
    expect(await dropFiles(page.locator(".local-workbench-host"), ["花型原图"], true)).toBe(true);
    await expect(page.getByText("元素已加入。文件原有透明度保留，不自动去背景。", { exact: true })).toBeVisible();
    const exported = await project(page, "导出 JSON");
    expect(exported.elements).toHaveLength(8);
    expect(bytes(exported.elements[7].src)).toEqual(IMAGE);
    expect(api.submissions).toHaveLength(0); expect(api.assetBytes.size).toBe(0);
});

test("a remote drop cannot append into a different local project after a switch", async ({ page, api }) => {
    await page.goto("/creative/pattern-placement");
    const selector = page.getByRole("combobox", { name: "本地工程" });
    await expect(selector).toBeEnabled();
    page.once("dialog", dialog => dialog.accept("另一个工程"));
    await page.getByRole("button", { name: "新建工程", exact: true }).click();
    await expect(page.locator("[data-project-status]")).toHaveText("已自动保存到本机");
    let held: Route | undefined, release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    await page.context().route("**/slow-workbench-reference.png", async route => { held = route; await wait; await route.fulfill({ contentType: "image/png", body: IMAGE }).catch(() => undefined); });
    await page.locator(".local-workbench-host").evaluate(element => {
        const data = new DataTransfer(); data.setData("text/uri-list", location.origin + "/slow-workbench-reference.png");
        element.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await expect.poll(() => Boolean(held)).toBe(true);
    page.once("dialog", dialog => dialog.accept("后来的工程"));
    await page.getByRole("button", { name: "新建工程", exact: true }).click();
    await expect(page.locator("[data-project-status]")).toHaveText("已自动保存到本机");
    release();
    await expect(page.locator(".local-workbench-host")).not.toHaveAttribute("aria-busy", "true");
    expect((await project(page, "导出工程 JSON")).layers).toHaveLength(1);
    expect(api.submissions).toHaveLength(0);
});
