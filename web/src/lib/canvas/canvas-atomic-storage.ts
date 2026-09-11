import localforage from "localforage";
import { localForageStorage } from "@/lib/localforage-storage";
import { withCanvasStorageLock } from "./canvas-persistence-merge";

/** Canvas alone needs a read/merge/write transaction, not independent storage calls. */
export async function updateCanvasStorage(name: string, update: (stored: string | null) => string | null): Promise<void> {
    if (typeof window === "undefined") return;
    await localforage.ready();
    if (localforage.driver() === localforage.INDEXEDDB) {
        // Only public settings are used. ready() has already initialized the
        // configured database/store; opening without a version never upgrades it.
        const databaseName = localforage.config("name") as string;
        const storeName = localforage.config("storeName") as string;
        await updateIndexedDb(databaseName, storeName, name, update);
        return;
    }
    if (typeof navigator === "undefined" || !navigator.locks) {
        throw new Error("当前浏览器既无 IndexedDB 事务也无保存锁，无法安全保存画布；改动仍保留，请导出备份或使用支持 IndexedDB 的浏览器");
    }
    await withCanvasStorageLock(name, async () => {
        const value = update(await localForageStorage.getItem(name));
        if (value === null) await localForageStorage.removeItem(name);
        else await localForageStorage.setItem(name, value);
    });
}

function updateIndexedDb(databaseName: string, storeName: string, name: string, update: (stored: string | null) => string | null): Promise<void> {
    return new Promise((resolve, reject) => {
        const opening = indexedDB.open(databaseName);
        let settled = false;
        let failure: unknown;
        const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
        opening.onupgradeneeded = () => {
            failure = new Error("画布存储尚未初始化，请重新打开页面后重试");
            opening.transaction?.abort();
        };
        opening.onerror = () => fail(failure || opening.error || new Error("无法打开画布存储"));
        opening.onblocked = () => fail(new Error("画布存储升级被其他窗口阻塞，请关闭旧窗口后重试"));
        opening.onsuccess = () => {
            const database = opening.result;
            if (settled) { database.close(); return; }
            database.onversionchange = () => database.close();
            let transaction: IDBTransaction;
            try { transaction = database.transaction(storeName, "readwrite"); }
            catch (error) { database.close(); fail(error); return; }
            transaction.onabort = () => { database.close(); fail(failure || transaction.error || new Error("画布保存事务已中止")); };
            transaction.onerror = () => { failure ||= transaction.error; };
            transaction.oncomplete = () => {
                database.close();
                if (!settled) { settled = true; resolve(); }
            };
            const store = transaction.objectStore(storeName);
            const reading = store.get(name);
            reading.onsuccess = () => {
                try {
                    const stored = reading.result;
                    if (stored !== undefined && stored !== null && typeof stored !== "string") throw new Error("画布存储内容格式异常，未覆盖原数据");
                    // Do not await inside a transaction: its get callback keeps
                    // this synchronous merge and put in the same active task.
                    const value = update(stored ?? null);
                    if (value === null) store.delete(name);
                    else store.put(value, name);
                } catch (error) {
                    failure = error;
                    transaction.abort();
                }
            };
        };
    });
}
