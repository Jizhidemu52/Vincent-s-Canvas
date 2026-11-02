import type { CreativeImageCatalogEntry } from "@/lib/creative-chat";
import { imageAgentVersion, imageAgentWorkId, resolveImageAgentFocus } from "@/lib/image-agent/focus";
import type { ChatSession } from "./chat-types";

export function chatFocusImage(catalog: CreativeImageCatalogEntry[], session?: Pick<ChatSession, "focusImageId" | "editTargetImageId" | "newCreation">) {
    try { return resolveImageAgentFocus(catalog, { focusId: session?.focusImageId || session?.editTargetImageId, newCreation: session?.newCreation }); }
    catch { return catalog.find(image => image.id === (session?.focusImageId || session?.editTargetImageId)); }
}

export function chatImageDisplayLabel(catalog: CreativeImageCatalogEntry[], imageId: string) {
    const image = catalog.find(item => item.id === imageId);
    if (!image) return "图片";
    const works = [...new Set(catalog.map(item => imageAgentWorkId(catalog, item)))];
    return `作品${works.indexOf(imageAgentWorkId(catalog, image)) + 1} · 第${imageAgentVersion(catalog, imageId)}版`;
}

/** Follow only persisted parent IDs. Missing links and cycles are not an original. */
export function chatImageOriginal(catalog: CreativeImageCatalogEntry[], imageId: string): { image?: CreativeImageCatalogEntry; reason?: string } {
    let image = catalog.find((entry) => entry.id === imageId);
    const visited = new Set<string>();
    while (image) {
        if (visited.has(image.id)) return { reason: "图片血缘存在循环，无法确定原图" };
        visited.add(image.id);
        if (image.unavailableReason) return { reason: image.unavailableReason };
        const parentId = image.parentId || image.lineage?.parentImageId;
        if (!parentId) return { image };
        image = catalog.find((entry) => entry.id === parentId);
    }
    return { reason: "原图不在当前会话中，无法回到原图" };
}
