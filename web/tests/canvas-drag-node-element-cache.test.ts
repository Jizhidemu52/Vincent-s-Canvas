import { describe, expect, test } from "bun:test";

import { createCanvasDragNodeElementCache } from "@/lib/canvas/canvas-drag-node-element-cache";

describe("canvas drag node element cache", () => {
    test("looks up each dragged node once and reuses it for later preview frames", () => {
        const first = { style: { transform: "" } };
        const second = { style: { transform: "" } };
        const lookups: string[] = [];
        const cache = createCanvasDragNodeElementCache((id) => {
            lookups.push(id);
            return id === "first" ? first : id === "second" ? second : null;
        });

        cache.warm(["first", "second"]);
        cache.apply(new Map([["first", { x: 12, y: 24 }], ["second", { x: -4, y: 6 }]]));
        cache.apply(new Map([["first", { x: 20, y: 30 }], ["second", { x: 8, y: 10 }]]));

        expect(lookups).toEqual(["first", "second"]);
        expect(first.style.transform).toBe("translate(20px, 30px)");
        expect(second.style.transform).toBe("translate(8px, 10px)");
    });

    test("memoizes absent elements so a missing node does not trigger a query every frame", () => {
        let lookups = 0;
        const cache = createCanvasDragNodeElementCache(() => {
            lookups += 1;
            return null;
        });

        cache.apply(new Map([["gone", { x: 1, y: 2 }]]));
        cache.apply(new Map([["gone", { x: 3, y: 4 }]]));

        expect(lookups).toBe(1);
    });

    test("clears cached elements after the drag transaction completes", () => {
        let lookups = 0;
        const node = { style: { transform: "" } };
        const cache = createCanvasDragNodeElementCache(() => {
            lookups += 1;
            return node;
        });

        cache.apply(new Map([["node", { x: 1, y: 2 }]]));
        cache.clear();
        cache.apply(new Map([["node", { x: 3, y: 4 }]]));

        expect(lookups).toBe(2);
    });
});
