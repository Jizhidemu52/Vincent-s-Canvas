import { describe, expect, test } from "bun:test";
import { placeCanvasImportedNodes } from "@/pages/canvas/canvas-import-placement";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const image = (id: string, x: number, y: number, width = 256, height = 256): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x, y }, width, height, metadata: { content: `blob:${id}`, storageKey: `original:${id}`, prompt: "original" } });
const overlaps = (a: CanvasNodeData, b: CanvasNodeData) => a.position.x < b.position.x + b.width && a.position.x + a.width > b.position.x && a.position.y < b.position.y + b.height && a.position.y + a.height > b.position.y;

describe("canvas import placement", () => {
    test("an empty canvas and a clear explicit drop keep their requested positions", () => {
        const imported = [image("new", 800, 20)];
        expect(placeCanvasImportedNodes([], imported)).toBe(imported);
        expect(placeCanvasImportedNodes([image("old", 0, 0)], imported)).toBe(imported);
    });
    test("successive toolbar uploads append right of the latest node without overlap", () => {
        let existing = [image("original", 0, 0)];
        for (let index = 0; index < 3; index++) {
            const [next] = placeCanvasImportedNodes(existing, [image(`new-${index}`, 0, 0)], true);
            expect(next.position.x).toBeGreaterThan(Math.max(...existing.map(node => node.position.x + node.width)));
            expect(existing.some(node => overlaps(node, next))).toBe(false);
            existing = [...existing, next];
        }
    });
    test("a colliding multi-file drop preserves grid gaps, source bytes and existing objects", () => {
        const existing = [image("old", -500, -500, 1600, 1800)];
        const imported = [image("a", 0, 0, 640, 400), image("b", 688, 0, 300, 640), image("c", 0, 688)];
        const snapshots = structuredClone({ existing, imported });
        const result = placeCanvasImportedNodes(existing, imported);
        expect(result.every(node => existing.every(item => !overlaps(node, item)))).toBe(true);
        expect(result[1].position.x - result[0].position.x).toBe(688);
        expect(result[2].position.y - result[0].position.y).toBe(688);
        expect(result.map(node => node.metadata)).toEqual(imported.map(node => node.metadata));
        expect({ existing, imported }).toEqual(snapshots);
    });
    test("a late second batch uses the already committed first batch for placement", () => {
        const first = [image("first", 2000, 2000)];
        const second = placeCanvasImportedNodes(first, [image("second", 2000, 2000)]);
        const third = placeCanvasImportedNodes([...first, ...second], [image("third", 2000, 2000)]);
        expect(overlaps(second[0], third[0])).toBe(false);
        expect(third[0].position.x).toBeGreaterThan(second[0].position.x);
    });
});
