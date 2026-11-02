export type WorkspaceIdentityDrainStatus = "idle" | "saving" | "saved" | "failed";

let status: WorkspaceIdentityDrainStatus = "idle";
let drain: (() => Promise<void>) | undefined;
const listeners = new Set<() => void>();

export const getWorkspaceIdentityDrainStatus = () => status;
export function subscribeWorkspaceIdentityDrain(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Registration does not import or initialize any employee workspace. */
export function registerWorkspaceIdentityDrain(saveOldPartition: () => Promise<void>) {
    if (status === "idle") drain = saveOldPartition;
}

function publish(next: WorkspaceIdentityDrainStatus) {
    status = next;
    listeners.forEach(listener => listener());
}

/** One terminal boundary per page lifetime. Saving never grants a new identity. */
export function startWorkspaceIdentityDrain() {
    if (status !== "idle") return;
    // Mark this before invoking the drainer: clearing identity notifies the
    // entry subscriber again synchronously while the old partition is drained.
    publish("saving");
    try {
        void Promise.resolve(drain?.()).then(() => publish("saved"), () => publish("failed"));
    } catch {
        publish("failed");
    }
}
