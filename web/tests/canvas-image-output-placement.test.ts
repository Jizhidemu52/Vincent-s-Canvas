import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { placeCanvasImageOutputs } from "@/lib/canvas/canvas-image-output-placement";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Image, title: "source", position: { x: 0, y: 0 }, width: 240, height: 240 };
test("places a result beside its source when there is free space", () => {
    expect(placeCanvasImageOutputs([source], [source], { width: 240, height: 240 }, { x: 0, y: 0 })).toEqual({ x: 276, y: 0 });
});
test("uses the nearest free row instead of moving results far down the canvas", () => {
    const video = { ...source, id: "video", type: CanvasNodeType.Video, position: { x: 280, y: 0 } };
    const lower = { ...source, id: "lower", position: { x: 280, y: 276 } };
    expect(placeCanvasImageOutputs([source, video, lower], [source], { width: 516, height: 240 }, { x: 0, y: 0 })).toEqual({ x: 276, y: -276 });
    expect(source.position).toEqual({ x: 0, y: 0 });
});
test("empty-canvas generation stays centered", () => {
    expect(placeCanvasImageOutputs([], [], { width: 240, height: 240 }, { x: 500, y: 400 })).toEqual({ x: 380, y: 280 });
});
test("an explicit cursor position anchors the batch even if it overlaps other nodes", () => {
    const position = { x: 12.5, y: -43.25 };
    expect(placeCanvasImageOutputs([source], [source], { width: 516, height: 516 }, { x: 500, y: 400 }, 36, position)).toEqual(position);
    expect(placeCanvasImageOutputs([source], [source], { width: 516, height: 516 }, { x: 500, y: 400 }, 36, null)).toEqual({ x: 276, y: 0 });
});

test("shared per-image results stay near their image and avoid the config and previous rounds", () => {
    const firstInput = { ...source, id: "a", position: { x: 40, y: 100 } };
    const secondInput = { ...source, id: "b", position: { x: 40, y: 430 } };
    const config = { ...source, id: "config", type: CanvasNodeType.Config, position: { x: 440, y: 210 }, width: 400, height: 460 };
    const nodes = [firstInput, secondInput, config];
    const initial = structuredClone(nodes);
    const overlaps = (a: CanvasNodeData, b: CanvasNodeData) => a.position.x < b.position.x + b.width && a.position.x + a.width > b.position.x && a.position.y < b.position.y + b.height && a.position.y + a.height > b.position.y;
    for (let round = 0; round < 2; round++) {
        for (const input of [firstInput, secondInput]) {
            const position = placeCanvasImageOutputs(nodes, [config, input], { width: 240, height: 240 }, input.position, 96);
            const result = { ...source, id: `result-${round}-${input.id}`, position };
            expect(position.x).toBeGreaterThanOrEqual(input.position.x + input.width + 96);
            expect(Math.hypot(position.x - input.position.x, position.y - input.position.y)).toBeLessThan(1500);
            expect(nodes.some(node => overlaps(result, node))).toBe(false);
            nodes.push(result);
        }
    }
    expect(nodes.slice(0, 3)).toEqual(initial);
});

test("the image execution path anchors shared results to the input and appends beside empty sources", () => {
    const project = readFileSync(new URL("../src/pages/canvas/use-canvas-generation.ts", import.meta.url), "utf8");
    const expression = project.match(/const outputPosition = ([\s\S]*?);\r?\n/)?.[1];
    expect(expression).toBeDefined();
    const config = { ...source, type: CanvasNodeType.Config, position: { x: 440, y: 210 }, width: 400, height: 460 };
    const env = { placeCanvasImageOutputs, workflowStep: false, parentPosition: source.position, nodesRef: { current: [source, config] }, referenceImages: [], snapshotNodes: [source, config],
        shared: { plan: { configNode: config, targetNode: source } }, sourceNode: source, imageConfig: { width: 240, height: 240 }, parentConfig: { width: 240, height: 240 }, gap: 96 };
    const code = ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const calculate = new Function("env", `const { ${Object.keys(env).join(",")} } = env; ${code}`);
    expect(calculate(env)).toEqual(placeCanvasImageOutputs([source, config], [source], { width: 240, height: 240 }, source.position, 96));
    // An empty source is retained as input; its newly generated result gets its own position.
    expect(calculate({ ...env, shared: undefined, nodesRef: { current: [source] } })).toEqual({ x: 336, y: 0 });
    expect(source.position).toEqual({ x: 0, y: 0 });
});
