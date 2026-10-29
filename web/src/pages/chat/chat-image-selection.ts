import type { CreativeImageCatalogEntry } from "@/lib/creative-chat";

/** Follow only persisted parent IDs. Missing links and cycles are not an original. */
export function chatImageOriginal(catalog: CreativeImageCatalogEntry[], imageId: string): { image?: CreativeImageCatalogEntry; reason?: string } {
    let image = catalog.find((entry) => entry.id === imageId);
    const visited = new Set<string>();
    while (image) {
        if (visited.has(image.id)) return { reason: "图片血缘存在循环，无法确定原图" };
        visited.add(image.id);
        if (image.unavailableReason) return { reason: image.unavailableReason };
        const parentId = image.lineage?.parentImageId;
        if (!parentId) return { image };
        image = catalog.find((entry) => entry.id === parentId);
    }
    return { reason: "原图不在当前会话中，无法回到原图" };
}
