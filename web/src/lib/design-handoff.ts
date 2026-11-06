import { designBriefSchema, type DesignBrief } from "../../../shared/design-brief";
import { createClientUuid } from "@/lib/client-uuid";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";
import { isModuleAvailable, useModuleStore } from "@/stores/use-module-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { isWorkspaceRole } from "../../../shared/workspace-access";
import type { ModuleKey } from "@/services/api/modules";
import type { ReferenceImage } from "@/types/image";

export const designDestinations = [
    { id: "creative-style-to-sketch", label: "款生线稿", href: "/creative/style-to-sketch" },
    { id: "creative-garment-colorway", label: "服装配色", href: "/creative/garment-colorway" },
    { id: "creative-local-restyle", label: "局部改款", href: "/creative/local-restyle" },
    { id: "creative-back-design", label: "背面设计", href: "/creative/back-design" },
    { id: "creative-pattern-extract", label: "花型提取", href: "/creative/pattern-extract" },
    { id: "image-edit", label: "图片编辑", href: "/image?tool=image-edit" },
] as const;
export type DesignDestination = typeof designDestinations[number]["id"];
const tokenPattern = /^[\w-]{1,80}$/;
export const designDraftScope = (token: string, destination: string) => `${destination}:design:${token}`;
export function designHandoffToken(params: URLSearchParams, destination: string): string | null {
    const token = params.get("designToken");
    return token && tokenPattern.test(token) && designDestinations.some(item => item.id === destination) ? token : null;
}

type Handoff = { version: 1; ownerId: string; destination: string; source: ReferenceImage; brief: DesignBrief; createdAt: number };
type Storage = Pick<ReturnType<typeof createWorkspaceStorage>, "getItem" | "setItem">;
type Dependencies = {
    ownerId: string; assertCurrent: (destination: string) => void; storage: Storage;
    resolve: typeof resolveImageUrl; upload: typeof uploadImage; id: () => string; now: () => number;
};

/** Immutable handoff only. Receivers own one-time draft initialization and never replay over edits. */
export function createDesignHandoff(deps: Dependencies) {
    return {
        async prepare(destination: string, source: ReferenceImage, brief: DesignBrief): Promise<string> {
            deps.assertCurrent(destination);
            const target = designDestinations.find(item => item.id === destination);
            if (!target) throw new Error("不支持此设计交接目标");
            const frozenBrief = designBriefSchema.parse(brief);
            let frozenSource: ReferenceImage = { ...source };
            if (!frozenSource.storageKey) {
                if (!source.dataUrl) throw new Error("结果原图不可用，未创建后续任务");
                const stored = await deps.upload(source.dataUrl);
                deps.assertCurrent(destination);
                frozenSource = { ...source, storageKey: stored.storageKey, type: stored.mimeType, width: stored.width, height: stored.height, bytes: stored.bytes };
            }
            if (!await deps.resolve(frozenSource.storageKey)) throw new Error("结果原图暂时无法读取，请保留原记录后重试");
            deps.assertCurrent(destination);
            const token = deps.id();
            if (!tokenPattern.test(token)) throw new Error("设计交接编号无效");
            frozenSource = { ...frozenSource, dataUrl: "", url: undefined };
            await deps.storage.setItem<Handoff>(token, { version: 1, ownerId: deps.ownerId, destination, source: frozenSource, brief: frozenBrief, createdAt: deps.now() });
            deps.assertCurrent(destination);
            return `${target.href}${target.href.includes("?") ? "&" : "?"}${new URLSearchParams({ designToken: token })}`;
        },
        async consume(token: string, destination: string): Promise<{ source: ReferenceImage; brief: DesignBrief }> {
            deps.assertCurrent(destination);
            if (!tokenPattern.test(token) || !designDestinations.some(item => item.id === destination)) throw new Error("设计交接链接无效");
            const payload = await deps.storage.getItem<Handoff>(token);
            deps.assertCurrent(destination);
            if (!payload || payload.version !== 1 || payload.ownerId !== deps.ownerId || payload.destination !== destination) throw new Error("此设计交接不属于当前账号或当前板块，请从原结果重新打开");
            const brief = designBriefSchema.parse(payload.brief);
            if (!payload.source?.storageKey) throw new Error("交接原图未保存，原设计记录不受影响");
            const dataUrl = await deps.resolve(payload.source.storageKey);
            deps.assertCurrent(destination);
            if (!dataUrl) throw new Error("交接原图暂时无法读取，请重试；不会自动生成或扣费");
            return { source: { ...payload.source, dataUrl }, brief };
        },
    };
}

function designHandoffAccess() {
    const ownerId = useUserStore.getState().user?.id;
    const assertCurrent = (destination: string) => {
        const { user, status } = useUserStore.getState();
        if (!ownerId || user?.id !== ownerId || status !== "authenticated" || user.status !== "active" || !isWorkspaceRole(user.role)) throw new Error("当前设计师会话已变化，请重新进入工作台");
        if (!designDestinations.some(item => item.id === destination) || !isModuleAvailable(useModuleStore.getState().flags, useBusinessConfigStore.getState().tools, destination as ModuleKey)) throw new Error("此后续板块已由管理员关闭");
    };
    return createDesignHandoff({ ownerId: ownerId || "", assertCurrent, storage: createWorkspaceStorage("design_handoffs"), resolve: resolveImageUrl, upload: uploadImage, id: createClientUuid, now: Date.now });
}
export function prepareDesignHandoff(destination: string, source: ReferenceImage, brief: DesignBrief) {
    return designHandoffAccess().prepare(destination, source, brief);
}
export function consumeDesignHandoff(token: string, destination: string) {
    return designHandoffAccess().consume(token, destination);
}
