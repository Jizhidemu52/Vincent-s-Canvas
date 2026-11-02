export const CANVAS_EDIT_LEASE_MS = 15_000;
export const CANVAS_EDIT_LEASE_RENEW_MS = 5_000;
export type CanvasEditLeaseRecord = { tab: string; expiresAt: number };

export function nextCanvasEditLease(current: CanvasEditLeaseRecord | undefined, tab: string, now: number, renew: boolean): CanvasEditLeaseRecord | null {
    if (renew ? !current || current.tab !== tab || current.expiresAt <= now : current && current.tab !== tab && current.expiresAt > now) return null;
    return { tab, expiresAt: now + CANVAS_EDIT_LEASE_MS };
}

/** HTTP intranet fallback. Read/check/write runs inside ONE serialized IDB transaction. */
export function createCanvasEditLease(databaseName = "wireless-canvas-editor-locks") {
    let database: Promise<IDBDatabase> | undefined;
    const open = () => database ??= new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore("leases");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("无法打开编辑保护存储"));
        request.onblocked = () => reject(new Error("编辑保护存储被其他标签页阻塞"));
    });
    const update = async (key: string, change: (record: CanvasEditLeaseRecord | undefined) => CanvasEditLeaseRecord | null | false) => {
        const db = await open();
        return new Promise<CanvasEditLeaseRecord | null>((resolve, reject) => {
            const transaction = db.transaction("leases", "readwrite");
            const store = transaction.objectStore("leases");
            const request = store.get(key);
            let result: CanvasEditLeaseRecord | null = null;
            request.onsuccess = () => {
                const value = change(request.result);
                if (value === false) return;
                result = value;
                if (value) store.put(value, key);
                else store.delete(key);
            };
            transaction.oncomplete = () => resolve(result);
            transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("编辑保护存储写入失败"));
        });
    };
    return {
        claim: (key: string, tab: string, now = Date.now()) => update(key, current => nextCanvasEditLease(current, tab, now, false) || false),
        renew: (key: string, tab: string, now = Date.now()) => update(key, current => nextCanvasEditLease(current, tab, now, true) || false),
        release: (key: string, tab: string) => update(key, current => current?.tab === tab ? null : false),
        close: () => { void database?.then(db => db.close()).catch(() => undefined); },
    };
}
