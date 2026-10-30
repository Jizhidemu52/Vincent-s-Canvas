import type { Position } from "@/types/canvas";
import { sameCanvasIdSet } from "./canvas-drag-visible-connections";

export type CanvasRepeatCopy = { selectedIds: ReadonlySet<string>; offset: Position };

/** Measured in screen pixels, independently of canvas zoom. */
export function exceedsCanvasDragThreshold(startX: number, startY: number, clientX: number, clientY: number) {
    return Math.hypot(clientX - startX, clientY - startY) > 3;
}

export function canvasRepeatCopyOffset(previous: CanvasRepeatCopy | null, selectedIds: ReadonlySet<string>): Position {
    return previous && sameCanvasIdSet(previous.selectedIds, selectedIds) ? previous.offset : { x: 36, y: 36 };
}

/** Remove only this transaction's copies; do not erase unrelated async updates. */
export function removeCanvasDragCopies<T extends { id: string }>(current: T[], copiedIds: ReadonlySet<string>, before: T[]): T[] {
    const remaining = current.filter(item => !copiedIds.has(item.id));
    // A cancelled gesture is a true no-op for the identity-based history.
    return remaining.length === before.length && remaining.every((item, index) => item === before[index]) ? before : remaining;
}
