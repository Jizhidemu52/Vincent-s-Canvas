import { deploymentFeatures } from "@/lib/deployment-features";
import { subscribeWorkspaceIdentity } from "@/lib/workspace-session-events";
import { hydratePromptReuse, resolvePromptReuse } from "@/services/api/prompts";
import { useUserStore } from "@/stores/use-user-store";

export function promptActionIdentity(state = useUserStore.getState()) {
    return `${state.status}:${state.user?.id || ""}:${state.user?.role || ""}`;
}

/** An interrupted action stays invalid even if the original account signs in again. */
export function createPromptActionGuard(expectedIdentity: string, alive: () => boolean = () => true) {
    let invalidated = false;
    const ownerId = useUserStore.getState().user?.id || null;
    const current = () => !invalidated && alive() && promptActionIdentity() === expectedIdentity;
    const unsubscribe = useUserStore.subscribe(state => {
        if (promptActionIdentity(state) !== expectedIdentity) invalidated = true;
    });
    const unsubscribeWorkspace = subscribeWorkspaceIdentity(owner => {
        if (owner !== ownerId) invalidated = true;
    });
    return {
        current,
        assert() {
            if (!current()) throw new Error("账号或页面已变化，本次操作已取消");
            const state = useUserStore.getState();
            if (deploymentFeatures.authenticationEnabled && state.status !== "authenticated") throw new Error("请先登录后再复用提示词");
        },
        dispose() { unsubscribe(); unsubscribeWorkspace(); },
    };
}

export async function resolveCompletePrompt(templateId: string, mode: "fill" | "fill_and_generate", assertCurrent: () => void) {
    assertCurrent();
    const resolved = await resolvePromptReuse(templateId, mode);
    assertCurrent();
    const payload = await hydratePromptReuse(resolved.reuseToken);
    assertCurrent();
    if (payload.template.id !== templateId) throw new Error("模板内容已变化，请刷新提示词库后重试");
    return { ...payload, reuseToken: resolved.reuseToken };
}
