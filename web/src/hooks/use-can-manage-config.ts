import { useAdminStore } from "@/stores/use-admin-store";
import { useUserStore } from "@/stores/use-user-store";

export function useCanManageConfig() {
    const user = useUserStore((state) => state.user);
    const canAccessAdmin = useAdminStore((state) => state.canAccessAdmin);
    return user?.role === "admin" && canAccessAdmin();
}
