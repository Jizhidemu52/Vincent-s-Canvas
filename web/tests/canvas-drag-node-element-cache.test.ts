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

    test("warms thousands of selected and offscreen nodes with one mounted-element scan", () => {
        const first = { style: { transform: "" } };
        const second = { style: { transform: "" } };
        let lookups = 0;
        let scans = 0;
        const cache = createCanvasDragNodeElementCache(() => { lookups++; return null; }, () => {
            scans++;
            return new Map([["node-0", first], ["node-1", second]]);
        });
        const ids = Array.from({ length: 5000 }, (_, i) => `node-${i}`);
        cache.warm(ids);
        cache.apply(new Map(ids.map((id, i) => [id, { x: i + 10, y: i + 20 }])));
        cache.apply(new Map([["node-4999", { x: 60, y: 80 }]]));
        expect(scans).toBe(1);
        expect(lookups).toBe(0);
        expect(first.style.transform).toBe("translate(10px, 20px)");
        expect(second.style.transform).toBe("translate(11px, 21px)");
    });

    test("a single-node drag keeps its one direct lookup instead of scanning the DOM", () => {
        let lookups = 0;
        let scans = 0;
        const node = { style: { transform: "" } };
        const cache = createCanvasDragNodeElementCache(() => { lookups++; return node; }, () => { scans++; return new Map(); });
        cache.warm(["node"]);
        cache.apply(new Map([["node", { x: 1, y: 2 }]]));
        expect(lookups).toBe(1);
        expect(scans).toBe(0);
        expect(node.style.transform).toBe("translate(1px, 2px)");
    });
});
