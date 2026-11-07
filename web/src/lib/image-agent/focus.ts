import type { ImageAgentWorkNote } from "./work-note";

/** Identity and parent links are persisted assets, not mutable preview URLs. */
export type ImageAgentImage = {
    id: string;
    label: string;
    kind: "upload" | "generated";
    name?: string;
    parentId?: string;
    workId?: string;
    note?: ImageAgentWorkNote;
    /** Requirements for this exact version, never evidence of visual correctness. */
    designBrief?: string;
    unavailableReason?: string;
};

export type ImageAgentFocus = { focusId?: string; explicitImageIds?: readonly string[]; newCreation?: boolean };
export const IMAGE_AGENT_MAX_IMAGES = 5;

function findImage<T extends ImageAgentImage>(images: readonly T[], value: string): T {
    const image = images.find(item => item.id === value) || images.find(item => item.label === value);
    if (!image) throw new Error("指定的图片已不在当前作品中，请重新选择；本次尚未提交生成。");
    if (image.unavailableReason) throw new Error(`${image.label}暂时不可读取，请重新提供图片；不会自动换成其他图。`);
    return image;
}

export function resolveImageAgentFocus<T extends ImageAgentImage>(images: readonly T[], selection: ImageAgentFocus = {}): T | undefined {
    if (selection.newCreation) return undefined;
    const explicit = selection.explicitImageIds?.[0];
    if (explicit) return findImage(images, explicit);
    if (selection.focusId) return findImage(images, selection.focusId);
    const latest = images.findLast(item => item.kind === "generated") || images.at(-1);
    return latest ? findImage(images, latest.id) : undefined;
}

export function originalImageAgentImage<T extends ImageAgentImage>(images: readonly T[], image: T): T {
    const seen = new Set<string>();
    let current = image;
    while (current.parentId) {
        if (seen.has(current.id)) throw new Error("作品版本关系异常，请重新选择底图。");
        seen.add(current.id);
        const parent = images.find(item => item.id === current.parentId);
        // A missing ancestor is not permission to call the latest image the original.
        if (!parent) throw new Error("作品原图已不可用，请重新添加原图。");
        current = parent;
    }
    return findImage(images, current.id);
}

/** UI selection is authoritative. A planner chooses direction, never overrides a lock. */
export function resolveImageAgentBase<T extends ImageAgentImage>(
    images: readonly T[],
    selection: { focusId?: string; lockedImageId?: string; newCreation?: boolean },
    requested?: string,
): T | undefined {
    if (selection.newCreation) return undefined;
    if (selection.lockedImageId) return findImage(images, selection.lockedImageId);
    const base = requested?.trim() || "focus";
    if (base === "none") return undefined;
    const focus = resolveImageAgentFocus(images, selection);
    if (base === "focus" || base === "latest") return focus;
    if (base === "original") {
        if (!focus) throw new Error("当前没有可回到的原图，请先选择作品。");
        return originalImageAgentImage(images, focus);
    }
    if (base === "previous") {
        if (!focus?.parentId) throw new Error("当前作品没有上一版，请选择另一张图片。");
        return findImage(images, focus.parentId);
    }
    return findImage(images, base);
}

/** No viewport sweep, no unrelated old works, no more than five decoded previews. */
export function selectImageAgentWorkingSet<T extends ImageAgentImage>(images: readonly T[], options: {
    focusId?: string; explicitIds?: readonly string[]; uploadIds?: readonly string[]; newCreation?: boolean;
} = {}): T[] {
    const chosen = new Map<string, T>();
    const add = (image: T | undefined) => { if (image && !image.unavailableReason && chosen.size < IMAGE_AGENT_MAX_IMAGES) chosen.set(image.id, image); };
    const explicit = [...new Set([...(options.explicitIds || []), ...(options.uploadIds || [])])];
    const focus = options.newCreation ? undefined : resolveImageAgentFocus(images, options);
    const mandatory = [...new Set([...explicit, ...(focus ? [focus.id] : [])])];
    if (mandatory.length > IMAGE_AGENT_MAX_IMAGES) throw new Error("当前图和参考图合计最多 5 张，请移除一张参考图后再试。");
    explicit.forEach(id => add(findImage(images, id)));
    add(focus);
    if (focus) {
        // Missing older originals should not break a valid current-image edit. Asking
        // for that missing original explicitly still fails in resolveImageAgentBase.
        try { add(originalImageAgentImage(images, focus)); } catch { /* unavailable history */ }
        if (focus.parentId) add(images.find(item => item.id === focus.parentId));
    }
    return [...chosen.values()];
}

export function imageAgentWorkId(images: readonly ImageAgentImage[], image: ImageAgentImage): string {
    if (image.workId) return image.workId;
    let current = image;
    const seen = new Set<string>();
    while (current.parentId && !seen.has(current.id)) {
        seen.add(current.id);
        const parent = images.find(item => item.id === current.parentId);
        if (!parent) return current.parentId;
        if (parent.workId) return parent.workId;
        current = parent;
    }
    return current.id;
}

export function getImageAgentVersions<T extends ImageAgentImage>(images: readonly T[], imageId: string): T[] {
    const selected = images.find(item => item.id === imageId);
    if (!selected) return [];
    const workId = imageAgentWorkId(images, selected);
    return images.filter(item => imageAgentWorkId(images, item) === workId);
}

export function imageAgentVersion(images: readonly ImageAgentImage[], imageId: string): number {
    return getImageAgentVersions(images, imageId).findIndex(item => item.id === imageId) + 1;
}

/** Suggestions only: never change focus or infer a version without its work context. */
export function imageAgentCandidateIds(content: string, images: readonly ImageAgentImage[], context: Pick<ImageAgentFocus, "focusId" | "newCreation"> = {}): string[] {
    if (!/[？?]|哪[一张个]|选择|确认/u.test(content)) return [];
    const candidates = new Set<string>();
    const matches = (token: string, identity = false) => {
        const boundary = identity ? "A-Za-z0-9_.:-" : "A-Za-z0-9_";
        return [...content.matchAll(new RegExp(`(?<![${boundary}])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![${boundary}])`, "gu"))];
    };
    const available = (image: ImageAgentImage | undefined): image is ImageAgentImage => Boolean(image && !image.unavailableReason);
    for (const image of images) {
        if (!available(image)) continue;
        for (const token of [image.id, image.label]) {
            if (token && images.filter(other => other.id === token || other.label === token).length === 1 && matches(token, token === image.id).length) candidates.add(image.id);
        }
    }
    // A unique literal name is useful even when a model omits 图N. Duplicate
    // names (including an unavailable duplicate) and version-like names are not identities.
    const versionName = /^(?:当前图|当前版|当前版本|这一版|这版|上一版|上个版本|前一版|原图|原版|最初版本|[vV]\s*\d+|第\s*\d+\s*版)$/u;
    const named = images.flatMap(image => {
        const name = image.name?.trim();
        if (!available(image) || !name || versionName.test(name) || images.filter(other => other.name?.trim() === name).length !== 1
            || images.some(other => other.id === name || other.label === name)) return [];
        return matches(name).map(match => ({ id: image.id, start: match.index, end: match.index + match[0].length }));
    });
    for (const match of named) {
        // “蓝色帽子” must not also select a separately named “帽子”. A separate
        // occurrence of the shorter name still remains an explicit candidate.
        if (!named.some(other => other.start <= match.start && other.end >= match.end && (other.start < match.start || other.end > match.end))) candidates.add(match.id);
    }
    const focus = context.newCreation ? undefined : images.find(image => image.id === context.focusId);
    if (available(focus)) {
        const add = (pattern: RegExp, image: ImageAgentImage | undefined) => { if (available(image) && pattern.test(content)) candidates.add(image.id); };
        add(/当前图|当前版(?:本)?|这一版|这版/u, focus);
        add(/上一版|上个版本|前一版/u, images.find(image => image.id === focus.parentId));
        try { add(/原图|原版|最初版本/u, originalImageAgentImage(images, focus)); } catch { /* Missing/cyclic ancestors are not candidates. */ }
        const versions = getImageAgentVersions(images, focus.id);
        for (const match of content.matchAll(/(?<![A-Za-z0-9_])[vV]\s*(\d+)(?![A-Za-z0-9_])|第\s*(\d+)\s*版/gu)) {
            const version = Number(match[1] || match[2]);
            const image = Number.isSafeInteger(version) && version > 0 ? versions[version - 1] : undefined;
            if (available(image)) candidates.add(image.id);
        }
    }
    return images.filter(image => candidates.has(image.id)).slice(0, IMAGE_AGENT_MAX_IMAGES).map(image => image.id);
}
