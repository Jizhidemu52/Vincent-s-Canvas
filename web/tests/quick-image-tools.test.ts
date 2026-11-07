import { expect, test } from "bun:test";
import { createImageTaskRequests } from "../src/services/api/generation-tasks";
import { navigationModuleKey, navigationTools } from "../src/constant/navigation-tools";
import { isQuickImageTool, quickImageAction, quickImageReferenceFileError, quickImageTitle } from "../src/lib/quick-image-tools";

test("quick references use processing limits without a frontend model selection", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
        expect(quickImageReferenceFileError({ type, size: 50 * 1024 * 1024 })).toBeUndefined();
    }
    for (const size of [0, -1, NaN, Infinity, 50 * 1024 * 1024 + 1]) {
        expect(quickImageReferenceFileError({ type: "image/png", size })).toBeDefined();
    }
    for (const type of ["image/svg+xml", "image/gif", "text/html"]) {
        expect(quickImageReferenceFileError({ type, size: 500 })).toBeDefined();
    }
});

test("one-click tools submit only their server action, not a prompt, model or user parameters", () => {
    for (const action of ["remove-background", "hd-upscale", "item-extract"] as const) {
        const request = createImageTaskRequests({ quickImageAction: action, toolKey: action === "hd-upscale" ? "detail-enhance" : "image-edit", operationType: action === "hd-upscale" ? "upscale" : "inpaint", requestId: "request-1", projectId: "project-1", modelConfigId: "untrusted-model", prompt: "untrusted-prompt", parameters: { size: "1K", count: 3 }, sourceUrls: ["/api/assets/one/content"], count: 3 })[0]!;
        expect(request.parameters).toEqual({ quickImageAction: action });
        expect(request).not.toHaveProperty("prompt"); expect(request).not.toHaveProperty("promptInput"); expect(request).not.toHaveProperty("modelConfigId");
        expect(request.requestId).toBe("request-1:0");
    }
});

test("standalone entries retain the existing module permissions", () => {
    expect(navigationTools.find(item => item.slug === "remove-background")?.path).toBe("/remove-background");
    expect(navigationTools.find(item => item.slug === "hd-upscale")?.path).toBe("/hd-upscale");
    expect(navigationTools.find(item => item.slug === "item-extract")?.path).toBe("/item-extract");
    expect(navigationModuleKey("remove-background")).toBe("image-edit");
    expect(navigationModuleKey("hd-upscale")).toBe("detail-enhance");
    expect(navigationModuleKey("item-extract")).toBe("image-edit");
});

test("product extraction is its own managed action, never an upscale or creative scene alias", () => {
    expect(isQuickImageTool("item-extract")).toBe(true);
    expect(quickImageAction("item-extract")).toBe("item-extract");
    expect(quickImageTitle("item-extract")).toBe("提取产品图");
    expect(isQuickImageTool("creative-item-extract")).toBe(false);
    expect(() => quickImageAction("unknown")).toThrow("不支持");
});
