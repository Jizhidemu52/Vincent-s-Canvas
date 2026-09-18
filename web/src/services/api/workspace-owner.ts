import { deploymentFeatures } from "@/lib/deployment-features";
import { useUserStore } from "@/stores/use-user-store";

/** Reject the shared-cookie race before a request can be attributed to another employee. */
export function workspaceOwnerHeaders(): Record<string, string> {
    if (!deploymentFeatures.oaLoginEnabled) return {};
    const { user, status } = useUserStore.getState();
    if (status !== "authenticated" || user?.role !== "designer") throw new Error("员工会话已变化，请从公司 OA 重新进入");
    return { "X-Canvas-Owner-Id": user.id };
}
