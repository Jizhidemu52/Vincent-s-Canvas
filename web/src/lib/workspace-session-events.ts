const channelName = "wireless-canvas:workspace-session";
type IdentityEvent = { type: "identity-changed"; ownerId: string | null; nonce: string };
const channel = typeof window !== "undefined" && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(channelName) : null;

/** This is only an invalidation signal. Receivers must revalidate with the server. */
export function broadcastWorkspaceIdentity(ownerId: string | null) {
    if (typeof window === "undefined") return;
    const event: IdentityEvent = { type: "identity-changed", ownerId, nonce: `${Date.now()}:${Math.random()}` };
    if (channel) channel.postMessage(event);
    else {
        try { window.localStorage.setItem(channelName, JSON.stringify(event)); }
        catch { /* Server owner checks remain authoritative if browser messaging is unavailable. */ }
    }
}

export function subscribeWorkspaceIdentity(listener: (ownerId: string | null) => void) {
    const receive = (value: unknown) => {
        const event = value as Partial<IdentityEvent> | null;
        if (event?.type === "identity-changed" && (event.ownerId === null || typeof event.ownerId === "string")) listener(event.ownerId);
    };
    const onMessage = (event: MessageEvent) => receive(event.data);
    const onStorage = (event: StorageEvent) => {
        if (event.key !== channelName || !event.newValue) return;
        try { receive(JSON.parse(event.newValue)); } catch { /* Ignore unrelated/corrupt browser messages. */ }
    };
    channel?.addEventListener("message", onMessage);
    if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
    return () => {
        channel?.removeEventListener("message", onMessage);
        if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    };
}
