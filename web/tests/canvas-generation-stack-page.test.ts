import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import ts from "typescript";
import { appendCanvasGenerationResultStack, canvasGenerationStackCover, reconcileCanvasGenerationStackNodes } from "@/lib/canvas/canvas-generation-stack";
import { createCanvasGenerationRecord } from "@/lib/canvas/canvas-generation-record";
import { canvasGenerationRunsForNodes } from "@/lib/canvas/canvas-project-async-lifecycle";
import { removeCanvasGroupMembers } from "@/lib/canvas/canvas-node-groups";
import { defaultConfig } from "@/stores/use-config-store";
import { uiText } from "@/lib/i18n";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeGroup } from "@/types/canvas";

// Exercise the actual page callbacks and option wiring, not copies of their logic.
const sourceText = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("project.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const initializers = new Map<string, ts.Expression>();
let generationOptions: ts.ObjectLiteralExpression | undefined;
function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) initializers.set(node.name.text, node.initializer);
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useCanvasGeneration" && ts.isObjectLiteralExpression(node.arguments[0])) generationOptions = node.arguments[0];
    ts.forEachChild(node, collect);
}
collect(ast);
function evaluate<T>(expression: string, scope: Record<string, unknown>): T {
    const code = ts.transpileModule(`const result = (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React } }).outputText;
    return new Function("scope", `const { ${Object.keys(scope).join(",")} } = scope; ${code}; return result;`)(scope);
}
function callback<T>(name: string, scope: Record<string, unknown>): T {
    const initializer = initializers.get(name);
    if (!initializer || !ts.isCallExpression(initializer)) throw new Error(`Missing callback ${name}`);
    return evaluate(initializer.arguments[0].getText(ast), scope);
}

const input: CanvasNodeData = { id: "input", type: CanvasNodeType.Image, title: "原图", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "blob:input", storageKey: "image:input" } };
function result(id: string): CanvasNodeData {
    return { ...input, id, position: { x: 200, y: 0 }, width: 200, height: 150, metadata: {
        generationStackSourceId: input.id, content: `blob:${id}`, storageKey: `image:${id}`, sourceTaskId: `task-${id}`, status: "success", mimeType: "image/png", naturalWidth: 2000, naturalHeight: 1500, bytes: 1234,
        generationRecord: createCanvasGenerationRecord({ id: `record-${id}`, sourceNodeId: input.id, prompt: "同参数测试", references: [], nodes: [input], config: defaultConfig, generationType: "edit" }),
    } };
}
function graph(count = 2) {
    let current = appendCanvasGenerationResultStack([input, result("r1"), result("r2")], "r2", () => "stack");
    for (let index = 3; index <= count; index++) {
        const next = appendCanvasGenerationResultStack([...current.nodes, result(`r${index}`)], `r${index}`, () => "unused");
        current = { ...next, addedConnections: [...current.addedConnections, ...next.addedConnections] };
    }
    return current;
}
function harness(nodes: CanvasNodeData[], connections: CanvasConnection[] = [], groups: CanvasNodeGroup[] = []) {
    const nodesRef = { current: nodes }, connectionsRef = { current: connections }, groupsRef = { current: groups };
    let dialog: string | null = "stack";
    const cleanup: { nodes: CanvasNodeData[] }[] = [], notices: unknown[] = [];
    let remove: (ids: Set<string>, confirmed?: boolean) => void;
    const scope = {
        React, uiText, nodesRef, connectionsRef, groupsRef, canvasGenerationStackCover, reconcileCanvasGenerationStackNodes, removeCanvasGroupMembers, canvasGenerationRunsForNodes,
        lastHistoryRef: { current: { nodes } }, historyRef: { current: { past: [] } }, generationRequestsRef: { current: new Map() },
        setNodes: (update: (previous: CanvasNodeData[]) => CanvasNodeData[]) => { nodesRef.current = update(nodesRef.current); },
        setConnections: (update: (previous: CanvasConnection[]) => CanvasConnection[]) => { connectionsRef.current = update(connectionsRef.current); },
        setGroups: (update: (previous: CanvasNodeGroup[]) => CanvasNodeGroup[]) => { groupsRef.current = update(groupsRef.current); },
        flushPendingHistory() {}, stopGenerationByRunningId() {}, undoCanvas() {}, NODE_STATUS_LOADING: "loading", modal: { confirm() { throw new Error("Successful stacks do not confirm running tasks"); } },
        deleteNodes: (ids: Set<string>, confirmed?: boolean) => remove(ids, confirmed), projectId: "stack-page-test", chatSessions: [],
        cleanupCanvasFiles: (value: { nodes: CanvasNodeData[] }) => cleanup.push(value), message: { info: (value: unknown) => notices.push(value), destroy() {} },
        setDialogNodeId: (update: (current: string | null) => string | null) => { dialog = update(dialog); },
        ...Object.fromEntries(["setSelectedNodeIds", "setSelectedConnectionId", "setHoveredNodeId", "setToolbarNodeId", "setEditingNodeId", "setInfoNodeId", "setCropNodeId", "setManualEditNode", "setMaskEditNodeId", "setAngleNodeId", "setPreviewNodeId", "setRunningNodeId", "setContextMenu"].map(name => [name, () => {}])),
    };
    remove = callback("deleteNodes", scope);
    return { nodesRef, connectionsRef, groupsRef, cleanup, notices, remove, dialog: () => dialog,
        primary: callback<(child: CanvasNodeData) => void>("setBatchPrimary", scope), exclusions: callback<() => Set<string>>("resultStackExcludedNodeIds", scope) };
}

test("page cover selection copies the full selected replay record without mutating originals or task bindings", () => {
    const initial = graph(), page = harness(initial.nodes, initial.addedConnections);
    const child = initial.nodes.find(node => node.id === "r2")!;
    const childSnapshot = JSON.stringify(child);
    page.primary(child);
    const cover = page.nodesRef.current.find(node => node.id === "stack")!;
    expect(cover.metadata).toMatchObject({ primaryImageId: "r2", storageKey: "image:r2", content: "blob:r2", sourceTaskId: "task-r2", mimeType: "image/png", bytes: 1234, generationRecord: { id: "record-r2" } });
    expect(cover.metadata?.imageTask).toBeUndefined(); expect(cover.metadata?.generationOrigin).toBeUndefined();
    expect(page.nodesRef.current.find(node => node.id === "r2")).toBe(child); expect(JSON.stringify(child)).toBe(childSnapshot);
    expect(page.nodesRef.current.find(node => node.id === "r1")).toBe(initial.nodes.find(node => node.id === "r1"));
});

test("storage-only persisted results can become the cover without retaining the old preview URL", () => {
    const initial = graph();
    const child = initial.nodes.find(node => node.id === "r2")!;
    child.metadata!.content = undefined;
    const page = harness(initial.nodes); page.primary(child);
    expect(page.nodesRef.current.find(node => node.id === "stack")?.metadata).toMatchObject({ primaryImageId: "r2", storageKey: "image:r2", generationRecord: { id: "record-r2" } });
    expect(page.nodesRef.current.find(node => node.id === "stack")?.metadata?.content).toBeUndefined();
});

test("ordinary generation batches keep their count, live binding and existing record semantics", () => {
    const child = { ...result("child"), metadata: { ...result("child").metadata, batchRootId: "batch" } };
    const root = { ...result("batch"), metadata: { ...result("batch").metadata, isBatchRoot: true, count: 3, status: "loading" as const, imageTask: { ownerId: "owner", projectId: "p", requestId: "running", resultIndex: 0 } } };
    const page = harness([root, child]); page.primary(child);
    const cover = page.nodesRef.current[0];
    expect(cover.metadata?.count).toBe(3); expect(cover.metadata?.imageTask).toBe(root.metadata.imageTask);
    expect(cover.metadata?.generationRecord).toBe(root.metadata.generationRecord); expect(cover.metadata?.status).toBe("loading");
    expect(cover.metadata?.content).toBe("blob:child");
});

test("deleting the selected cover child replaces all replay metadata and removes dangling edges", () => {
    const initial = graph(3), page = harness(initial.nodes, [...initial.addedConnections, { id: "stale", fromNodeId: "missing", toNodeId: "input" }]);
    page.remove(new Set(["r1"]));
    expect(page.nodesRef.current.find(node => node.id === "stack")?.metadata).toMatchObject({ primaryImageId: "r2", batchChildIds: ["r2", "r3"], sourceTaskId: "task-r2", generationRecord: { id: "record-r2" }, storageKey: "image:r2" });
    expect(page.connectionsRef.current.map(edge => edge.id)).toEqual(["stack:source", "stack:result:r2", "stack:result:r3"]);
    expect(page.cleanup.at(-1)?.nodes).toEqual(page.nodesRef.current);
});

test("a one-result stack dissolves at the same position and clears its edges, group membership and open tools", () => {
    const initial = graph(), root = initial.nodes.find(node => node.id === "stack")!;
    const page = harness(initial.nodes, [...initial.addedConnections, { id: "real-input", fromNodeId: "input", toNodeId: "r2" }], [{ id: "style", title: "Style", nodeIds: ["stack", "r1", "r2"] }]);
    const requested = new Set(["r1"]); page.remove(requested);
    expect(page.nodesRef.current.map(node => node.id)).toEqual(["input", "r2"]);
    const survivor = page.nodesRef.current[1];
    expect(survivor.position).toEqual(root.position); expect(survivor.metadata?.batchRootId).toBeUndefined();
    expect(survivor.metadata?.generationRecord?.id).toBe("record-r2"); expect(survivor.metadata?.storageKey).toBe("image:r2");
    expect(page.connectionsRef.current).toEqual([{ id: "real-input", fromNodeId: "input", toNodeId: "r2" }]);
    expect(page.groupsRef.current).toEqual([]); expect(page.dialog()).toBeNull();
    expect(page.cleanup.at(-1)?.nodes).toEqual(page.nodesRef.current); expect(requested).toEqual(new Set(["r1"]));
});

test("deleting a whole result stack retains its original input and leaves no stack connections", () => {
    const initial = graph(3), page = harness(initial.nodes, initial.addedConnections);
    page.remove(new Set(["stack"]));
    expect(page.nodesRef.current).toEqual([input]); expect(page.connectionsRef.current).toEqual([]);
});

test("generation receives a stable provider that reads current manual-group membership at completion time", () => {
    const page = harness([input], [], [{ id: "a", title: "A", nodeIds: ["input", "r1"] }]);
    const option = generationOptions?.properties.find(property => property.name?.getText(ast) === "resultStackExcludedNodeIds");
    if (!option || !ts.isShorthandPropertyAssignment(option)) throw new Error("Missing actual useCanvasGeneration exclusion provider");
    const provider = evaluate<() => Set<string>>(option.name.getText(ast), { resultStackExcludedNodeIds: page.exclusions });
    expect(provider).toBe(page.exclusions); expect([...provider()]).toEqual(["input", "r1"]);
    page.groupsRef.current = [{ id: "b", title: "B", nodeIds: ["r2", "stack"] }, { id: "c", title: "C", nodeIds: ["r2", "r3"] }];
    expect([...provider()]).toEqual(["r2", "stack", "r3"]);
    const nodes = [input, result("r1"), result("r2")];
    expect(appendCanvasGenerationResultStack(nodes, "r2", () => "forbidden", provider()).nodes).toBe(nodes);
});
