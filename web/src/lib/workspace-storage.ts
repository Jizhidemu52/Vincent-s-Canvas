import localforage from "localforage";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useUserStore } from "@/stores/use-user-store";

/** A page owns one immutable partition. Identity changes require a fresh bootstrap. */
export function createWorkspaceStorage(storeName: string, options: Pick<LocalForageOptions, "driver"> = {}) {
    const enterprise = deploymentFeatures.oaLoginEnabled;
    const user = useUserStore.getState().user;
    const owner = enterprise && user?.role === "designer" ? user.id : null;
    const available = typeof window !== "undefined" && (!enterprise || Boolean(owner));
    const storage = available ? localforage.createInstance({
        name: enterprise ? `wireless-canvas:oa:user:${encodeURIComponent(owner!)}` : "wireless-canvas",
        storeName,
        ...options,
    }) : null;
    const hasIdentity = () => !enterprise || Boolean(owner && useUserStore.getState().user?.id === owner && useUserStore.getState().user?.role === "designer");
    const isCurrent = () => available && hasIdentity();
    const assertIdentity = () => {
        if (!hasIdentity()) throw new Error("员工会话已变化，请从公司 OA 重新进入");
    };
    const assertAccess = () => {
        assertIdentity();
        if (!storage) throw new Error("当前环境无法使用浏览器持久存储");
    };
    return {
        available,
        isCurrent,
        assertIdentity,
        assertAccess,
        async getItem<T>(key: string): Promise<T | null> {
            assertAccess();
            const value = await storage!.getItem<T>(key);
            assertAccess();
            return value;
        },
        async setItem<T>(key: string, value: T): Promise<T> {
            assertAccess();
            const saved = await storage!.setItem(key, value);
            assertAccess();
            return saved;
        },
        async removeItem(key: string): Promise<void> {
            assertAccess();
            await storage!.removeItem(key);
            assertAccess();
        },
        async iterate<T, U>(iterator: (value: T, key: string, iterationNumber: number) => U): Promise<U> {
            assertAccess();
            const result = await storage!.iterate<T, U>((value, key, index) => { assertAccess(); return iterator(value, key, index); });
            assertAccess();
            return result;
        },
    };
}
