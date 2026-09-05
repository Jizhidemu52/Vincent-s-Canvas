import { useEffect, useState } from "react";

import { CANVAS_DESKTOP_MEDIA_QUERY } from "@/lib/canvas/canvas-layout-breakpoint";

function currentCanvasDesktopLayout() {
    return typeof window !== "undefined" && window.matchMedia(CANVAS_DESKTOP_MEDIA_QUERY).matches;
}

export function useCanvasDesktopLayout() {
    const [isDesktop, setIsDesktop] = useState(currentCanvasDesktopLayout);

    useEffect(() => {
        const query = window.matchMedia(CANVAS_DESKTOP_MEDIA_QUERY);
        const sync = () => setIsDesktop(query.matches);
        sync();
        query.addEventListener("change", sync);
        return () => query.removeEventListener("change", sync);
    }, []);

    return isDesktop;
}
