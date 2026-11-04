export const CANVAS_EDIT_LEASE_MS = 15_000;
export const CANVAS_EDIT_LEASE_RENEW_MS = 5_000;
export type CanvasEditLeaseRecord = { tab: string; expiresAt: number };

export function nextCanvasEditLease(current: CanvasEditLeaseRecord | undefined, tab: string, now: number, renew: boolean): CanvasEditLeaseRecord | null {
    if (renew ? !current || current.tab !== tab || current.expiresAt <= now : current && current.tab !== tab && current.expiresAt > now) return null;
    return { tab, expiresAt: now + CANVAS_EDIT_LEASE_MS };
}

/** An expired owner may resume ONLY if nobody has acquired/released its record. */
export function resumeCanvasEditLease(current: CanvasEditLeaseRecord | undefined, tab: string, now: number): CanvasEditLeaseRecord | null {
    return current?.tab === tab ? { tab, expiresAt: now + CANVAS_EDIT_LEASE_MS } : null;
}

/** HTTP intranet fallback. Read/check/write runs inside ONE serialized IDB transaction. */
export function createCanvasEditLease(databaseName = "wireless-canvas-editor-locks") {
    let database: Promise<IDBDatabase> | undefined;
    const open = () => database ??= new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        let failed = false;
        const fail = (error: Error) => { failed = true; reject(error); };
        request.onupgradeneeded = () => request.result.createObjectStore("leases");
        request.onsuccess = () => { if (failed) request.result.close(); else resolve(request.result); };
        request.onerror = () => fail(request.error ?? new Error("无法打开编辑保护存储"));
        request.onblocked = () => fail(new Error("编辑保护存储被其他标签页阻塞"));
    }).catch(error => {
        // A transient open/blocked failure must not poison this editor forever.
        // A late success from a blocked request is closed instead of leaked.
        database = undefined;
        throw error;
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
        // Read the clock in the transaction, not before waiting for IDB to open.
        claim: (key: string, tab: string, now?: number) => update(key, current => nextCanvasEditLease(current, tab, now ?? Date.now(), false) || false),
        renew: (key: string, tab: string, now?: number) => update(key, current => nextCanvasEditLease(current, tab, now ?? Date.now(), true) || false),
        resume: (key: string, tab: string, now?: number) => update(key, current => resumeCanvasEditLease(current, tab, now ?? Date.now()) || false),
        release: (key: string, tab: string) => update(key, current => current?.tab === tab ? null : false),
        close: () => { void database?.then(db => db.close()).catch(() => undefined); },
    };
}
