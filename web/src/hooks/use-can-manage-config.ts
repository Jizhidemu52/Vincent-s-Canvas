import { useUserStore } from "@/stores/use-user-store";

export function useCanManageConfig() {
    const user = useUserStore((state) => state.user);
    return user?.role === "super_admin";
}
