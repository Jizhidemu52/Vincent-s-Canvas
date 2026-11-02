export function isCanvasStorageQuotaError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const value = error as { name?: string; code?: number; cause?: unknown };
    return value.name === "QuotaExceededError" || value.name === "NS_ERROR_DOM_QUOTA_REACHED" || value.code === 22 || value.code === 1014
        || Boolean(value.cause && isCanvasStorageQuotaError(value.cause));
}

export async function requestCanvasPersistentStorage() {
    if (typeof navigator === "undefined" || !navigator.storage) return;
    try {
        if (navigator.storage.persist && !await navigator.storage.persisted?.()) await navigator.storage.persist();
        const estimate = await navigator.storage.estimate?.();
        return estimate?.quota && estimate.usage !== undefined ? estimate.usage / estimate.quota : undefined;
    } catch { return undefined; }
}
