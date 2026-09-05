const revokeBrowserObjectUrl = (url: string) => URL.revokeObjectURL(url);

export function cacheObjectUrl(urls: Map<string, string>, key: string, url: string, revokeObjectUrl = revokeBrowserObjectUrl) {
    const previous = urls.get(key);
    if (previous && previous !== url) revokeObjectUrl(previous);
    urls.set(key, url);
}

export function releaseObjectUrl(urls: Map<string, string>, key: string, revokeObjectUrl = revokeBrowserObjectUrl) {
    const url = urls.get(key);
    if (url) revokeObjectUrl(url);
    urls.delete(key);
}

/**
 * Frees browser-only object URLs while leaving the underlying persisted blobs
 * untouched. A later resolve can recreate a URL for any retained file.
 */
export function releaseUnusedObjectUrls(urls: Map<string, string>, usedKeys: ReadonlySet<string>, revokeObjectUrl = revokeBrowserObjectUrl) {
    Array.from(urls.keys()).forEach((key) => {
        if (!usedKeys.has(key)) releaseObjectUrl(urls, key, revokeObjectUrl);
    });
}
