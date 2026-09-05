type StoredImage = { storageKey?: string; dataUrl: string };
export async function hydrateImageLogMedia<T extends { images: StoredImage[]; references: StoredImage[] }>(log: T, resolve: (key?: string, fallback?: string) => Promise<string>, includeReferences = true): Promise<T> {
    const hydrate = async <I extends StoredImage>(item: I) => ({ ...item, dataUrl: await resolve(item.storageKey, item.dataUrl) });
    const [images, references] = await Promise.all([Promise.all(log.images.map(hydrate)), includeReferences ? Promise.all(log.references.map(hydrate)) : log.references]);
    return { ...log, images, references };
}
