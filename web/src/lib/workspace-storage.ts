import localforage from "localforage";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useUserStore } from "@/stores/use-user-store";
import { createStorageAccess } from "./storage-access";

/** A page owns one immutable partition. Identity changes require a fresh bootstrap. */
export function createWorkspaceStorage(storeName: string, options: Pick<LocalForageOptions, "driver"> = {}) {
    const enterprise = deploymentFeatures.authenticationEnabled;
    const { user, status } = useUserStore.getState();
    const owner = enterprise && status === "authenticated" && user?.role === "designer" ? user.id : null;
    const available = typeof window !== "undefined" && (!enterprise || Boolean(owner));
    const name = enterprise ? `wireless-canvas:oa:user:${encodeURIComponent(owner!)}` : "wireless-canvas";
    const storage = available ? localforage.createInstance({
        name,
        storeName,
        ...options,
    }) : null;
    const access = storage ? createStorageAccess(name, () => storage.ready()) : null;
    const hasIdentity = () => !enterprise || Boolean(owner && useUserStore.getState().status === "authenticated" && useUserStore.getState().user?.id === owner && useUserStore.getState().user?.role === "designer");
    const isCurrent = () => available && hasIdentity();
    const assertIdentity = () => {
        if (!hasIdentity()) throw new Error("员工会话已变化，请重新登录后进入工作区");
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
            const value = await access!.run(() => { assertAccess(); return storage!.getItem<T>(key); });
            assertAccess();
            return value;
        },
        async setItem<T>(key: string, value: T): Promise<T> {
            assertAccess();
            const saved = await access!.run(() => { assertAccess(); return storage!.setItem(key, value); });
            assertAccess();
            return saved;
        },
        async removeItem(key: string): Promise<void> {
            assertAccess();
            await access!.run(() => { assertAccess(); return storage!.removeItem(key); });
            assertAccess();
        },
        async iterate<T, U>(iterator: (value: T, key: string, iterationNumber: number) => U): Promise<U> {
            assertAccess();
            const result = await access!.run(() => {
                assertAccess();
                return storage!.iterate<T, U>((value, key, index) => { assertAccess(); return iterator(value, key, index); });
            });
            assertAccess();
            return result;
        },
    };
}
