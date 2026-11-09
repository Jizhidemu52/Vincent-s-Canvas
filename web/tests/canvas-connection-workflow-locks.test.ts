import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { normalizeCanvasConnection, imageWorkflowConnectionError } from "@/lib/canvas/canvas-shared-connections";
import { canvasConnectionCreateOptions } from "@/lib/canvas/canvas-connection-create-options";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/types/canvas";

const source = readFileSync(new URL("../src/pages/canvas/use-canvas-connections.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("connections.ts", source, ts.ScriptTarget.Latest, true);
function callback(name: string, bindings: Record<string, unknown>) {
    let expression: ts.Expression | undefined;
    function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) expression = node.initializer; ts.forEachChild(node, visit); }
    visit(ast); if (!expression) throw new Error(`Missing callback ${name}`);
    const code = ts.transpileModule(`return (${expression.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    return new Function(...Object.keys(bindings), code)(...Object.values(bindings));
}
const image = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 64, height: 64, metadata: { content: "fixture", status: "success" } });
const config = (id: string): CanvasNodeData => ({ ...image(id), type: CanvasNodeType.Config, metadata: { generationMode: "image", prompt: id } });
function fixture() {
    const nodesRef = { current: [image("source-a"), image("source-b"), config("a"), config("b")] };
    const connectionsRef = { current: [{ id: "edge-a", fromNodeId: "source-a", toNodeId: "a" }, { id: "edge-b", fromNodeId: "source-b", toNodeId: "b" }] as CanvasConnection[] };
    const reconnectingIdRef = { current: null as string | null }, warnings: string[] = [], effects: string[] = [];
    const generationDispatchLocksRef = { current: new Set(["image-sequence:live-a", "a"]) };
    const bindings = {
        nodesRef, connectionsRef, reconnectingIdRef, generationDispatchLocksRef, CanvasNodeType, imageWorkflowConnectionError, canvasConnectionCreateOptions,
        uiText: (text: string) => text, useCallback: (fn: unknown) => fn, effectiveConfig: {},
        normalizeConnection(from: string, to: string, nodes: CanvasNodeData[], handle: "source" | "target") { return normalizeCanvasConnection(nodes.find(node => node.id === from)!, nodes.find(node => node.id === to)!, handle); },
        message: { info: (text: string) => warnings.push(text), warning: (text: string) => warnings.push(text) },
        setConnections(update: (nodes: CanvasConnection[]) => CanvasConnection[]) { connectionsRef.current = update(connectionsRef.current); effects.push("connections"); },
        setNodes(update: (nodes: CanvasNodeData[]) => CanvasNodeData[]) { nodesRef.current = update(nodesRef.current); effects.push("nodes"); },
        setSelectedConnectionId() {}, setContextMenu() {}, flushPendingHistory() { effects.push("history"); }, setDialogNodeId() {}, setPendingConnectionCreate() {}, setSelectedNodeIds() {},
        setConnecting() {}, screenToCanvas: () => ({ x: 0, y: 0 }), connectionInitialPreviewRef: { current: null }, connectionPointerRef: { current: null }, connectionStartRef: { current: null },
        createCanvasNode: (type: CanvasNodeType) => ({ ...config("new"), type }), nanoid: () => "new-edge",
    };
    const error = callback("connectionError", bindings);
    return { nodesRef, connectionsRef, reconnectingIdRef, generationDispatchLocksRef, warnings, effects, error,
        create: callback("createConnectedNode", bindings), remove: callback("deleteConnection", bindings), reconnect: callback("handleReconnectStart", bindings) };
}

test("running A does not block an independent B connection, but both new and old rewire endpoints are protected", () => {
    const f = fixture();
    expect(f.error({ nodeId: "source-b", handleType: "source" }, "b")).toBeNull();
    expect(f.error({ nodeId: "source-a", handleType: "source" }, "a")).toContain("此节点");
    f.reconnectingIdRef.current = "edge-a";
    expect(f.error({ nodeId: "source-b", handleType: "source" }, "b")).toContain("此节点");
    f.reconnectingIdRef.current = "edge-b";
    expect(f.error({ nodeId: "source-b", handleType: "source" }, "a")).toContain("此节点");
});

test("building a node from an unrelated source is allowed while a running source is protected", () => {
    const f = fixture();
    f.create(CanvasNodeType.Config, { connection: { nodeId: "source-b", handleType: "source" }, position: { x: 200, y: 0 } });
    expect(f.nodesRef.current.some(node => node.id === "new")).toBe(true);
    expect(f.connectionsRef.current.find(edge => edge.id === "new-edge")).toMatchObject({ fromNodeId: "source-b", toNodeId: "new" });
    const effects = f.effects.length;
    f.create(CanvasNodeType.Config, { connection: { nodeId: "a", handleType: "source" }, position: { x: 200, y: 0 } });
    expect(f.effects).toHaveLength(effects); expect(f.warnings).toHaveLength(1);
});

test("deleting or starting rewiring touches only an unlocked edge, not every live workflow", () => {
    const f = fixture(), a = f.connectionsRef.current[0]!, b = f.connectionsRef.current[1]!;
    const event = { button: 0, clientX: 0, clientY: 0, pointerId: 1, preventDefault() {}, stopPropagation() {}, currentTarget: { setPointerCapture() {} } };
    f.reconnect(event, a, "target"); expect(f.reconnectingIdRef.current).toBeNull();
    f.reconnect(event, b, "target"); expect(f.reconnectingIdRef.current).toBe("edge-b");
    f.remove("edge-a"); expect(f.connectionsRef.current).toContain(a);
    f.remove("edge-b"); expect(f.connectionsRef.current).toEqual([a]);
    expect(f.warnings).toHaveLength(2);
});
