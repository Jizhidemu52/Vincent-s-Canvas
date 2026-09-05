import { describe, expect, test } from "bun:test";

import { beginCanvasHover, commitCanvasHover, endCanvasHover, resetCanvasHover } from "@/lib/canvas/canvas-hover-stability";

describe("canvas hover stability", () => {
    test("drops a transient hover before it can update the external highlight", () => {
        const pending = beginCanvasHover({ activeId: null, pendingId: null }, "node-a");

        expect(endCanvasHover(pending, "node-a")).toEqual({ activeId: null, pendingId: null });
    });

    test("keeps the prior stable hover until its replacement has settled", () => {
        const pendingReplacement = beginCanvasHover({ activeId: "node-a", pendingId: null }, "node-b");
        const afterLeavingPrevious = endCanvasHover(pendingReplacement, "node-a");

        expect(afterLeavingPrevious).toEqual({ activeId: "node-a", pendingId: "node-b" });
        expect(commitCanvasHover(afterLeavingPrevious)).toEqual({ activeId: "node-b", pendingId: null });
    });

    test("clears a stable hover when the pointer leaves without a replacement", () => {
        expect(endCanvasHover({ activeId: "node-a", pendingId: null }, "node-a")).toEqual({ activeId: null, pendingId: null });
    });

    test("resets both active and pending hover state when canvas movement begins", () => {
        expect(resetCanvasHover({ activeId: "active", pendingId: "pending" })).toEqual({ activeId: null, pendingId: null });
    });
});
