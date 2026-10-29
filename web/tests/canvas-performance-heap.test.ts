import { expect, test } from "bun:test";
import { analyzeCanvasHeap } from "../scripts/canvas-performance-heap.mjs";

test("heap-table audit distinguishes shared nodes from snapshot-array counts", () => {
    const strings = ["Object", "Array", "id", ...Array.from({ length: 500 }, (_, index) => `performance-node-${index}`)];
    const objects: { name: number; edges: number[][] }[] = [];
    const add = (name: number, edges: number[][] = []) => { const offset = objects.length * 2; objects.push({ name, edges }); return offset; };
    const ids = Array.from({ length: 500 }, (_, index) => add(index + 3));
    const shared = ids.map(id => add(0, [[0, 2, id]]));
    for (let version = 0; version < 201; version++) {
        const edited = version ? add(0, [[0, 2, ids[0]!]]) : shared[0]!;
        add(1, [edited, ...shared.slice(1)].map((offset, index) => [1, index, offset]));
    }
    const snapshot = { snapshot: { meta: { node_fields: ["name", "edge_count"], edge_fields: ["type", "name_or_index", "to_node"], edge_types: [["property", "element"], "string_or_number", "node"] } },
        nodes: objects.flatMap(object => [object.name, object.edges.length]), edges: objects.flatMap(object => object.edges.flat()), strings };
    expect(analyzeCanvasHeap(snapshot)).toEqual({ matchingNodeObjects: 700, graphArrays: 201, sharingClusterArrays: 201, sharingClusterUniqueNodes: 700, unchangedNodeMaxCopies: 1, changedNodeVersions: 201 });
});
