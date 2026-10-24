import { deploymentFeatures } from "@/lib/deployment-features";
import { useUserStore } from "@/stores/use-user-store";
import { isWorkspaceRole } from "../../../../shared/workspace-access";

/** Reject the shared-cookie race before a request can be attributed to another employee. */
export function workspaceOwnerHeaders(): Record<string, string> {
    if (!deploymentFeatures.authenticationEnabled) return {};
    const { user, status } = useUserStore.getState();
    if (status !== "authenticated" || !user || !isWorkspaceRole(user.role)) throw new Error("员工会话已变化，请重新登录后进入工作区");
    return { "X-Canvas-Owner-Id": user.id };
}
