import type { Cache, createCache } from "./db";

export type ProductCandidatesReceiptConnection = {
    cache: Pick<Cache, "get" | "eval">;
    confirmPersistence(): Promise<boolean>;
    close(): void;
};

/** WAITAOF blocks only this short-lived connection, never the shared request cache.
 * No reconnect/offline queue: confirmation cannot move to a fresh connection whose
 * write offset would not include the claim. Requires existing Redis >=7.2 + AOF.
 */
export async function openProductCandidatesReceiptConnection(parent: Awaited<ReturnType<typeof createCache>>): Promise<ProductCandidatesReceiptConnection> {
    const dedicated = parent.duplicate({ disableOfflineQueue: true, socket: { reconnectStrategy: false, connectTimeout: 5000 }, commandOptions: { timeout: 7500 } });
    // Redis emits socket errors in addition to rejecting the active command.
    // The route handles that rejection without logging connection credentials.
    dedicated.on("error", () => undefined);
    const close = () => { if (dedicated.isOpen) dedicated.destroy(); };
    try { await dedicated.connect(); }
    catch (error) { close(); throw error; }
    return {
        cache: dedicated,
        confirmPersistence: async () => {
            const result = await dedicated.sendCommand(["WAITAOF", "1", "0", "5000"]);
            return Array.isArray(result) && result.length === 2 && Number(result[0]) === 1;
        },
        close,
    };
}
