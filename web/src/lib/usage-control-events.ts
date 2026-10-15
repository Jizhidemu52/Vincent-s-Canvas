/** Explicit semantic events for controls whose portals consume native click events. Never pass input content. */
export function emitModelUsage(action: "open" | "change", modelConfigId?: string) {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("business-model-usage", { detail: { action, modelConfigId } }));
}
