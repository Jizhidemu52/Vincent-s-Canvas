import { expect, test } from "bun:test";

import { bindCanvasPointerInteractionEnd, canvasPointerInteractionEndEvents } from "@/lib/canvas/canvas-pointer-interaction";

test("treats a browser pointer cancellation as the end of a canvas interaction", () => {
    expect(canvasPointerInteractionEndEvents).toEqual(["pointerup", "pointercancel", "blur"]);
});

test("removes the cancellation listener with the rest of the canvas interaction listeners", () => {
    const target = new EventTarget();
    let calls = 0;
    const dispose = bindCanvasPointerInteractionEnd(target, () => {
        calls += 1;
    });

    target.dispatchEvent(new Event("pointercancel"));
    expect(calls).toBe(1);

    target.dispatchEvent(new Event("blur"));
    expect(calls).toBe(2);

    dispose();
    target.dispatchEvent(new Event("pointercancel"));
    target.dispatchEvent(new Event("blur"));
    expect(calls).toBe(2);
});
