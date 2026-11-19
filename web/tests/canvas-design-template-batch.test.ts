import { describe, expect, test } from "bun:test";
import { canvasDesignTemplateBatch } from "../src/lib/canvas/canvas-design-template-batch";
import { runCanvasDesignTemplateBatch } from "../src/pages/canvas/canvas-shared-generation-runtime";
import { createCanvasDesignTemplate } from "../src/lib/canvas/canvas-design-templates";
import { CanvasNodeType } from "../src/types/canvas";

const template = () => createCanvasDesignTemplate("range", undefined, { x: 0, y: 0 }, "image-model");

describe("template batch execution", () => {
    test("every branch resolves the same batch, including templates saved without new metadata", () => {
        const first = template(), second = template();
        const nodes = [...first.nodes, ...second.nodes], groups = [first.group, second.group], edges = [...first.connections, ...second.connections];
        for (const node of first.nodes.filter(node => node.type === CanvasNodeType.Config)) {
            const batch = canvasDesignTemplateBatch(node.id, nodes, groups, edges)!;
            expect(batch.nodes.map(item => item.id)).toEqual(first.nodes.filter(item => item.type === CanvasNodeType.Config).map(item => item.id));
        }
        expect(canvasDesignTemplateBatch(first.nodes[0]!.id, nodes, groups, edges)).toBeNull();
    });

    test("ordinary groups, removed members and explicit sequence workflows never fan out unexpectedly", () => {
        const graph = template(), configs = graph.nodes.filter(node => node.type === CanvasNodeType.Config);
        expect(canvasDesignTemplateBatch(configs[0]!.id, graph.nodes, [], graph.connections)).toBeNull();
        expect(canvasDesignTemplateBatch(configs[0]!.id, graph.nodes, [{ ...graph.group, nodeIds: [configs[0]!.id] }], graph.connections)).toBeNull();
        expect(canvasDesignTemplateBatch(configs[0]!.id, graph.nodes, [graph.group], [...graph.connections, { id: "sequence", fromNodeId: configs[0]!.id, toNodeId: configs[1]!.id, kind: "config-sequence" }])).toBeNull();
        const removed = graph.nodes.filter(node => node.id !== configs[2]!.id);
        expect(canvasDesignTemplateBatch(configs[0]!.id, removed, [graph.group], graph.connections)!.nodes).toHaveLength(2);
    });

    test("starts all branches immediately, blocks duplicate clicks and releases only its own lock", async () => {
        const graph = template(), batch = canvasDesignTemplateBatch(graph.nodes[1]!.id, graph.nodes, [graph.group], graph.connections)!;
        const locks = new Set(["unrelated"]), calls: string[] = [], complete: (() => void)[] = [];
        const generate = async (node: typeof graph.nodes[number]) => { calls.push(node.id); await new Promise<void>(resolve => complete.push(resolve)); };
        const first = runCanvasDesignTemplateBatch(batch, locks, generate);
        expect(calls).toHaveLength(3);
        expect(await runCanvasDesignTemplateBatch(batch, locks, generate)).toBe(false);
        complete[0]!(); await Promise.resolve();
        expect(locks.has(batch.id)).toBe(true);
        complete[1]!(); complete[2]!(); await first;
        expect([...locks]).toEqual(["unrelated"]);
        expect(calls).toHaveLength(3);
    });

    test("one failing branch cannot prevent the other branches from finishing or cause an automatic retry", async () => {
        const graph = template(), batch = canvasDesignTemplateBatch(graph.nodes[1]!.id, graph.nodes, [graph.group], graph.connections)!;
        const locks = new Set<string>(), calls: string[] = [];
        await expect(runCanvasDesignTemplateBatch(batch, locks, async node => { calls.push(node.id); if (node === batch.nodes[0]) throw new Error("provider failure"); })).rejects.toThrow("provider failure");
        expect(calls).toHaveLength(3); expect(locks.size).toBe(0);
    });
});
