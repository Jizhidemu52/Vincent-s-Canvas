import { createClientUuid, type ClientRandomSource } from "./client-uuid";

export function createClientId(source: ClientRandomSource | undefined = globalThis.crypto): string {
    if (typeof source?.randomUUID === "function" || typeof source?.getRandomValues === "function") return createClientUuid(source);

    // Legacy local-only identifiers do not have a server UUID contract.
    return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
