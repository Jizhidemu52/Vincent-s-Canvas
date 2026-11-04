import { expect, test } from "bun:test";
import { nextCanvasEditLease, resumeCanvasEditLease, CANVAS_EDIT_LEASE_MS } from "@/lib/canvas/canvas-edit-lease";

test("lease policy excludes live foreign owners, rejects expired renewals and recovers expired owners", () => {
    const current = { tab: "one", expiresAt: 100 };
    expect(nextCanvasEditLease(current, "two", 99, false)).toBeNull();
    expect(nextCanvasEditLease(current, "two", 99, true)).toBeNull();
    expect(nextCanvasEditLease(current, "one", 100, true)).toBeNull();
    expect(nextCanvasEditLease(current, "two", 100, false)).toEqual({ tab: "two", expiresAt: 100 + CANVAS_EDIT_LEASE_MS });
    expect(nextCanvasEditLease(undefined, "one", 100, true)).toBeNull();
    expect(nextCanvasEditLease(undefined, "one", 100, false)?.tab).toBe("one");
});

test("resume retains an uninterrupted owner's draft but never steals or recreates a lost lease", () => {
    expect(resumeCanvasEditLease({ tab: "one", expiresAt: 100 }, "one", 20_000)).toEqual({ tab: "one", expiresAt: 20_000 + CANVAS_EDIT_LEASE_MS });
    expect(resumeCanvasEditLease({ tab: "two", expiresAt: 100 }, "one", 20_000)).toBeNull();
    expect(resumeCanvasEditLease(undefined, "one", 20_000)).toBeNull();
    expect(resumeCanvasEditLease({ tab: "one", expiresAt: 30_000 }, "one", 20_000)?.tab).toBe("one");
});
