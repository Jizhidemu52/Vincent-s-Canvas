import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { canvasHistoryForSave, type CanvasHistoryEntry } from "@/pages/canvas/use-canvas-history";
import { CanvasNodeType } from "@/types/canvas";

const ast = ts.createSourceFile("project.tsx", readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = "";
function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "finishNodeResize") callback = ts.transpileModule(`return ${node.initializer!.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    ts.forEachChild(node, collect);
}
collect(ast);

test.each([false, true])("resize finish with changed=%s cleans preview and only real geometry changes create an undo step", changed => {
    const previous: CanvasHistoryEntry = { nodes: [{ id: "a", type: CanvasNodeType.Image, title: "a", position: { x: 10, y: 20 }, width: 100, height: 200 }], connections: [], groups: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false };
    let nodes = previous.nodes, resizing = true, interacting = true;
    const scope = { useCallback: (fn: unknown) => fn, resizePreviewRafRef: { current: 1 }, pendingResizePreviewRef: { current: new Map() }, resizePreviewRef: { current: new Map([["a", {}]]) }, resizeConnectionIdsRef: { current: new Set(["edge"]) }, nodeResizingRef: { current: true },
        cancelAnimationFrame() {}, setResizePreviewById() {}, setResizeConnectionIds() {}, setIsNodeResizing(value: boolean) { resizing = value; }, handleCanvasInteractionChange(value: boolean) { interacting = value; }, setNodes(update: (prev: typeof nodes) => typeof nodes) { nodes = update(nodes); } };
    const finish = new Function("scope", `const { ${Object.keys(scope).join(",")} } = scope; ${callback}`)(scope);
    finish("a", changed ? 150 : 100, 200, { x: 10, y: 20 });
    expect(resizing).toBe(false); expect(interacting).toBe(false);
    expect(scope.resizePreviewRef.current.size).toBe(0);
    const history = canvasHistoryForSave({ past: [], future: [] }, previous, { ...previous, nodes }, false);
    expect(history.past).toHaveLength(changed ? 1 : 0);
    if (!changed) { expect(nodes).toBe(previous.nodes); expect(nodes[0]).toBe(previous.nodes[0]); }
    else expect(nodes[0].width).toBe(150);
});
