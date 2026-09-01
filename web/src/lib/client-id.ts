type RandomUuidSource = {
    randomUUID?: () => string;
};

export function createClientId(source: RandomUuidSource | undefined = globalThis.crypto): string {
    if (typeof source?.randomUUID === "function") return source.randomUUID();

    return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
