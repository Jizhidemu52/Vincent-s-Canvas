/** Events that always finish a canvas pan, including browser interruption. */
export const canvasPointerInteractionEndEvents = ["pointerup", "pointercancel", "blur"] as const;

/** Attaches the paired end events and returns one cleanup function. */
export function bindCanvasPointerInteractionEnd(target: Pick<EventTarget, "addEventListener" | "removeEventListener">, listener: EventListener) {
    canvasPointerInteractionEndEvents.forEach((eventName) => target.addEventListener(eventName, listener));
    return () => canvasPointerInteractionEndEvents.forEach((eventName) => target.removeEventListener(eventName, listener));
}
