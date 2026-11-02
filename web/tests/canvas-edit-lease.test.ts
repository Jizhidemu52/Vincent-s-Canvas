import { expect, test } from "bun:test";
import { nextCanvasEditLease, CANVAS_EDIT_LEASE_MS } from "@/lib/canvas/canvas-edit-lease";

test("lease policy excludes live foreign owners, rejects expired renewals and recovers expired owners", () => {
    const current = { tab: "one", expiresAt: 100 };
    expect(nextCanvasEditLease(current, "two", 99, false)).toBeNull();
    expect(nextCanvasEditLease(current, "two", 99, true)).toBeNull();
    expect(nextCanvasEditLease(current, "one", 100, true)).toBeNull();
    expect(nextCanvasEditLease(current, "two", 100, false)).toEqual({ tab: "two", expiresAt: 100 + CANVAS_EDIT_LEASE_MS });
    expect(nextCanvasEditLease(undefined, "one", 100, true)).toBeNull();
    expect(nextCanvasEditLease(undefined, "one", 100, false)?.tab).toBe("one");
});
