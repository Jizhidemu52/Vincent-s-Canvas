import { useCanvasEntryUsage } from "@/hooks/use-canvas-entry-usage";
import type { CanvasUsageEntry } from "../../../../shared/usage-analytics";

export function CanvasEntryUsage({ entry, open, instance }: { entry: CanvasUsageEntry; open: boolean; instance?: string }) {
    useCanvasEntryUsage(entry, open, instance);
    return null;
}
