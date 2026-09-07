import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/image-utils";

/** Only the clock rerenders each second, not the workbench and its media/history. */
export function GenerationElapsed({ startedAt }: { startedAt: number }) {
    const [elapsed, setElapsed] = useState(0);
    useEffect(() => {
        const tick = () => setElapsed(startedAt ? Math.max(0, performance.now() - startedAt) : 0);
        tick();
        const timer = window.setInterval(tick, 1000);
        return () => window.clearInterval(timer);
    }, [startedAt]);
    return <>{formatDuration(elapsed)}</>;
}
