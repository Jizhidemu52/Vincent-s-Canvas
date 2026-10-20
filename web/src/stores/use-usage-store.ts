import { create } from "zustand";
import localforage from "localforage";
import { createStorageAccess } from "@/lib/storage-access";
import { UsageSession, type UsageLocalState } from "@/lib/usage-session";
import { getMyUsage, postUsageEvents } from "@/services/api/usage-client";
import type { UsageClientEvent } from "../../../shared/usage-analytics";
import { useUserStore } from "@/stores/use-user-store";
import { deploymentFeatures } from "@/lib/deployment-features";
import { createClientUuid } from "@/lib/client-uuid";

type UsageStore = { owner: string | null; counts: Record<string, number>; storageUnavailable: boolean };
export const useUsageStore = create<UsageStore>(() => ({ owner: null, counts: {}, storageUnavailable: false }));
let session: UsageSession | null = null;
const persistence = new Map<string, { read: () => Promise<UsageLocalState | null>; write: (value: UsageLocalState) => Promise<void> }>();
function ownerStorage(owner: string) {
    const known = persistence.get(owner); if (known) return known;
    const name = `wireless-canvas:usage:user:${encodeURIComponent(owner)}`;
    const storage = localforage.createInstance({ name, storeName: "usage" });
    const access = createStorageAccess(name, () => storage.ready());
    let chain: Promise<unknown> = Promise.resolve();
    const run = <T,>(operation: () => Promise<T>) => { const next = chain.catch(() => undefined).then(() => access.run(operation)); chain = next; return next; };
    const result = { read: () => run(() => storage.getItem<UsageLocalState>("activity-v1")), write: (value: UsageLocalState) => run(async () => { await storage.setItem("activity-v1", value); }) };
    persistence.set(owner, result); return result;
}
export function setUsageOwner(owner: string | null, enterprise: boolean) {
    if (session?.owner === owner && session.enterprise === enterprise) return;
    session?.dispose(); session = null;
    useUsageStore.setState({ owner, counts: {}, storageUnavailable: false });
    if (!owner) return;
    const checkOwner = () => { const state = useUserStore.getState(); if (state.status !== "authenticated" || state.user?.status !== "active" || state.user.id !== owner) throw new Error("Usage owner changed"); };
    const next = new UsageSession(owner, enterprise, { ...ownerStorage(owner), post: (events, signal) => { checkOwner(); return postUsageEvents(events, signal); }, me: signal => { checkOwner(); return getMyUsage(signal); },
        changed: (counts, storageUnavailable) => { if (session === next) useUsageStore.setState({ counts, storageUnavailable }); } });
    session = next;
}
export function recordUsage(event: Omit<UsageClientEvent, "eventId"> & { eventId?: string }, visitToken?: string) {
    if (!session) return;
    // ID generation belongs inside the optional telemetry boundary, not in
    // React effects. Neither sync failures nor rejected writes may crash work.
    const unavailable = () => console.warn("Usage event could not be recorded");
    try { void session.record({ ...event, eventId: event.eventId ?? createClientUuid() }, visitToken).catch(unavailable); }
    catch { unavailable(); }
}
export function flushUsage() { return session?.flush() ?? Promise.resolve(); }
// Abort synchronously with identity changes, before a pending timer can submit under the next account's cookie.
useUserStore.subscribe(state => {
    const owner = state.status === "authenticated" && state.user?.status === "active" ? state.user.id : null;
    if (owner !== session?.owner) setUsageOwner(owner, deploymentFeatures.authenticationEnabled);
});
