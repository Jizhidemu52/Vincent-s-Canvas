import { v4 as uuidV4 } from "uuid";

export type ClientRandomSource = {
    randomUUID?: () => string;
    getRandomValues?: (bytes: Uint8Array) => Uint8Array;
};

/** UUIDs for persisted/server-validated records, including non-secure HTTP origins. */
export function createClientUuid(source: ClientRandomSource | undefined = globalThis.crypto): string {
    if (typeof source?.randomUUID === "function") return source.randomUUID();
    if (typeof source?.getRandomValues !== "function") throw new Error("Browser secure random generation is unavailable");
    // getRandomValues is available on HTTP too. Keep RFC UUID formatting in the
    // library; never substitute Math.random or a non-UUID client ID for records.
    return uuidV4({ random: source.getRandomValues(new Uint8Array(16)) });
}
