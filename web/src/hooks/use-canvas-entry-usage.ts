import { useEffect, useRef } from "react";
import { recordUsage, useUsageStore } from "@/stores/use-usage-store";
import type { CanvasUsageEntry } from "../../../shared/usage-analytics";

export function useCanvasEntryUsage(entry: CanvasUsageEntry, open: boolean, instance = "") {
    const previous = useRef<{ owner: string; entry: CanvasUsageEntry; instance: string } | null>(null);
    useEffect(() => {
        if (!open) { previous.current = null; return; }
        const observe = ({ owner }: { owner: string | null }) => {
            if (!owner) { previous.current = null; return; }
            const last = previous.current;
            if (last?.owner === owner && last.entry === entry && last.instance === instance) return;
            previous.current = { owner, entry, instance };
            recordUsage({ boardKey: "canvas", action: "open", controlKey: `canvas_entry_open.${entry}`, occurredAt: new Date().toISOString() });
        };
        observe(useUsageStore.getState());
        return useUsageStore.subscribe((next, prior) => { if (next.owner !== prior.owner) observe(next); });
    }, [entry, instance, open]);
}
