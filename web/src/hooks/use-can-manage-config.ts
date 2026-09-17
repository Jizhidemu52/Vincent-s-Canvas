import { useUserStore } from "@/stores/use-user-store";
import { deploymentFeatures } from "@/lib/deployment-features";

export function useCanManageConfig() {
    const user = useUserStore((state) => state.user);
    return !deploymentFeatures.oaLoginEnabled && user?.role === "super_admin";
}
