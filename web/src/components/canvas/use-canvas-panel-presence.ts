import { useEffect, useState, useSyncExternalStore } from "react";

export const CANVAS_PANEL_MOTION_MS = 240;
const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
const subscribe = (notify: () => void) => {
    const media = window.matchMedia(reducedMotionQuery);
    media.addEventListener("change", notify);
    return () => media.removeEventListener("change", notify);
};
const snapshot = () => window.matchMedia(reducedMotionQuery).matches;

/** Visual retention only: callers must keep the business open state authoritative. */
export function useCanvasPanelPresence(open: boolean) {
    const reducedMotion = useSyncExternalStore(subscribe, snapshot, () => true);
    const [retained, setRetained] = useState(open);
    useEffect(() => {
        if (open) { setRetained(true); return; }
        if (!retained) return;
        if (reducedMotion) { setRetained(false); return; }
        const timer = setTimeout(() => setRetained(false), CANVAS_PANEL_MOTION_MS);
        return () => clearTimeout(timer);
    }, [open, reducedMotion, retained]);
    return { present: open || retained && !reducedMotion, closing: !open && retained && !reducedMotion };
}
