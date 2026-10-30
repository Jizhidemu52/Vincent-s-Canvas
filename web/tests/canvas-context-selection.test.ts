import { describe, expect, test } from "bun:test";
import { uiText } from "@/lib/i18n";
import { readFileSync } from "node:fs";
import React, { type ReactElement } from "react";
import ts from "typescript";

import { cloneCanvasNodeGraph, copyCanvasNodeGraph } from "@/lib/canvas/canvas-node-copy";
import { removeCanvasGroupMembers } from "@/lib/canvas/canvas-node-groups";
import { canvasGenerationRunsForNodes } from "@/lib/canvas/canvas-project-async-lifecycle";
import { canvasImageExportSelection } from "@/lib/canvas/canvas-image-export-selection";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeGroup, type ContextMenuState } from "@/types/canvas";

// Execute the page's real callback bodies and context-menu JSX; only React state
// setters and the file-cleanup boundary are supplied, without mounting the editor.
const source = ["project.tsx", "use-canvas-connections.ts"]
    .map(file => readFileSync(new URL(`../src/pages/canvas/${file}`, import.meta.url), "utf8")).join("\n");
const ast = ts.createSourceFile("project.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const initializers = new Map<string, ts.Expression>();
let menuJsx: ts.JsxSelfClosingElement | undefined;
function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) initializers.set(node.name.text, node.initializer);
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "CanvasNodeContextMenu") menuJsx = node;
    ts.forEachChild(node, collect);
}
collect(ast);

function expression<T>(text: string, scope: Record<string, unknown>): T {
    const code = ts.transpileModule(`const subject = (${text});`, {
        compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React },
    }).outputText;
    return new Function("scope", `const { ${Object.keys(scope).join(",")} } = scope; ${code}\nreturn subject;`)(scope);
}

function callback(name: string, scope: Record<string, unknown>): (...args: any[]) => any {
    const initializer = initializers.get(name);
    if (!initializer || !ts.isCallExpression(initializer) || !initializer.arguments[0]) throw new Error(`Missing page callback: ${name}`);
    return expression(initializer.arguments[0].getText(ast), scope);
}

function node(id: string, x = 0): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, width: 80, height: 60, position: { x, y: 10 }, metadata: { content: `blob:${id}`, storageKey: `image:${id}` } };
}

function pointer(modifiers: Record<string, boolean> = {}, button = 2) {
    return {
        button, clientX: 240, clientY: 160, shiftKey: false, metaKey: false, ctrlKey: false, ...modifiers,
        prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
    };
}

function pageHarness(initialNodes = [node("a"), node("b", 100), node("c", 300)], selected = ["a", "b"],
    initialConnections: CanvasConnection[] = [], initialGroups: CanvasNodeGroup[] = []) {
    const state = { nodes: initialNodes, connections: initialConnections, groups: initialGroups, selectedNodeIds: new Set(selected),
        selectedConnectionId: null as string | null, dialogNodeId: null as string | null, contextMenu: null as ContextMenuState | null };
    const writes: Record<string, number> = {};
    const cleanup: unknown[] = [];
    const confirmations: Array<{ onOk: () => void }> = [];
    const stopped: unknown[][] = [];
    const targets = { duplicate: [] as ReadonlySet<string>[], delete: [] as ReadonlySet<string>[], connection: [] as string[] };
    const clipboard = { token: "unchanged-clipboard", nodes: [node("clipboard")], connections: [] };
    const clipboardRef = { current: clipboard };
    const update = <K extends keyof typeof state>(key: K) => (value: typeof state[K] | ((current: typeof state[K]) => typeof state[K])) => {
        writes[key] = (writes[key] || 0) + 1;
        state[key] = typeof value === "function" ? (value as (current: typeof state[K]) => typeof state[K])(state[key]) : value;
    };
    const scope: Record<string, unknown> = {
        uiText,
        React, lastHistoryRef: { current: { nodes: initialNodes } }, historyRef: { current: { past: [] } }, undoCanvas: () => {}, message: { info: () => {}, destroy: () => {} },
        CanvasNodeType, copyCanvasNodeGraph, cloneCanvasNodeGraph, removeCanvasGroupMembers, clipboardRef,
        flushPendingHistory: () => true, generationRequestsRef: { current: new Map() }, generationDispatchLocksRef: { current: new Set() }, stopGenerationByRunningId: (...args: unknown[]) => stopped.push(args),
        canvasGenerationRunsForNodes, NODE_STATUS_LOADING: "loading", modal: { confirm: (value: { onOk: () => void }) => confirmations.push(value) },
        deleteNodes: (...args: unknown[]) => remove(...args),
        nodesRef: { get current() { return state.nodes; } }, connectionsRef: { get current() { return state.connections; } },
        groupsRef: { get current() { return state.groups; } }, selectedNodeIdsRef: { get current() { return state.selectedNodeIds; } },
        setNodes: update("nodes"), setConnections: update("connections"), setGroups: update("groups"),
        setSelectedNodeIds: update("selectedNodeIds"), commitSelectedNodeIds: update("selectedNodeIds"),
        setSelectedConnectionId: update("selectedConnectionId"), setDialogNodeId: update("dialogNodeId"), setContextMenu: update("contextMenu"),
        projectId: "context-selection-fixture", chatSessions: [], cleanupCanvasFiles: (input: unknown) => { cleanup.push(input); },
        ...Object.fromEntries(["setHoveredNodeId", "setToolbarNodeId", "setEditingNodeId", "setInfoNodeId", "setCropNodeId", "setManualEditNode",
            "setMaskEditNodeId", "setAngleNodeId", "setPreviewNodeId", "setRunningNodeId"].map(name => [name, () => undefined])),
    };
    const duplicate = callback("duplicateNodes", scope), remove = callback("deleteNodes", scope), disconnect = callback("deleteConnection", scope);
    const open = callback("handleNodeContextMenu", scope);
    const menu = () => {
        const contextMenuNodeIds = callback("contextMenuNodeIds", { contextMenu: state.contextMenu, selectedNodeIds: state.selectedNodeIds })() as Set<string>;
        if (!menuJsx) throw new Error("Missing actual page context-menu JSX");
        const element = expression<ReactElement<any>>(menuJsx.getText(ast), {
            ...scope, React, CanvasNodeContextMenu: "context-menu-fixture", contextMenu: state.contextMenu, contextMenuNodeIds,
            nodes: state.nodes, resetViewport: () => {},
            contextMenuImageCount: canvasImageExportSelection(state.nodes, [...contextMenuNodeIds]).length,
            openSelectedImageDownload: () => undefined,
            selectedNodeIds: state.selectedNodeIds, localToolsEnabled: true, createSelectedGroup: () => undefined,
            duplicateNodes: (ids: ReadonlySet<string>) => { targets.duplicate.push(ids); duplicate(ids); },
            deleteNodes: (ids: ReadonlySet<string>) => { targets.delete.push(ids); remove(ids); },
            deleteConnection: (id: string) => { targets.connection.push(id); disconnect(id); },
        });
        return { props: element.props, ids: contextMenuNodeIds };
    };
    return { state, scope, writes, cleanup, targets, clipboard, clipboardRef, duplicate, remove, open, menu, confirmations, stopped };
}

describe("page context-menu input and selection", () => {
    test.each([false, true])("right mousedown/up does not drag, pause history or open a panel (group proxy=%s)", throughGroup => {
        const page = pageHarness();
        const originalSelection = page.state.selectedNodeIds;
        const dragRef = { current: { isDraggingNode: false, hasMoved: false, initialSelectedNodes: [], startX: 0, startY: 0 } };
        const historyPausedRef = { current: throughGroup }, nodeDraggingRef = { current: false }, draggingGroupRef = { current: false };
        const dragEffects: boolean[] = [];
        const scope = { ...page.scope, dragRef, historyPausedRef, nodeDraggingRef, draggingGroupRef,
            rafRef: { current: null }, pendingDragPreviewRef: { current: null },
            setIsNodeDragging: (value: boolean) => { dragEffects.push(value); }, handleCanvasInteractionChange: (value: boolean) => { dragEffects.push(value); } };
        const down = callback("handleNodeMouseDown", scope), up = callback("finishNodeDrag", scope);
        const event = pointer({ ctrlKey: true, shiftKey: true });
        if (throughGroup) {
            callback("moveGroup", { handleNodeMouseDown: down, groupIndex: { groups: [{ group: { id: "group" }, nodes: [node("a"), node("b")], nodeIds: new Set(["a", "b"]) }] } })(event, "group");
        } else down(event, "a");
        up(event.clientX, event.clientY);
        expect(event.stopped).toBe(true);
        expect(dragRef.current).toEqual({ isDraggingNode: false, hasMoved: false, initialSelectedNodes: [], startX: 0, startY: 0 });
        expect(historyPausedRef.current).toBe(throughGroup);
        expect(nodeDraggingRef.current).toBe(false);
        expect(draggingGroupRef.current).toBe(false);
        expect(dragEffects).toEqual([]);
        expect(page.state.selectedNodeIds).toBe(originalSelection);
        expect(page.writes).toEqual({});
        expect(page.state.dialogNodeId).toBeNull();
    });

    test.each([{}, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }])("contextmenu preserves selected peers but replaces selection for an unselected target, with modifiers %j", modifiers => {
        const page = pageHarness();
        const selected = page.state.selectedNodeIds;
        const selectedEvent = pointer(modifiers);
        page.open(selectedEvent, "a");
        expect(selectedEvent.prevented && selectedEvent.stopped).toBe(true);
        expect(page.state.selectedNodeIds).toBe(selected);
        expect(page.state.selectedNodeIds).toEqual(new Set(["a", "b"]));
        expect(page.writes.selectedNodeIds || 0).toBe(0);
        expect(page.state.contextMenu).toEqual({ type: "node", x: 240, y: 160, nodeId: "a" });
        page.open(pointer(modifiers), "c");
        expect(page.state.selectedNodeIds).toEqual(new Set(["c"]));
        expect(page.writes.selectedNodeIds).toBe(1);
        expect(page.state.contextMenu).toMatchObject({ type: "node", nodeId: "c" });
    });

    test.each(["source", "target"])("a right press cannot start a %s connection, while the primary press still can", handleType => {
        const connectionInitialPreviewRef = { current: null as unknown }, connectionTargetNodeIdRef = { current: "hovered" as string | null };
        const changes: unknown[] = [], projected: number[][] = [];
        const start = callback("handleConnectStart", {
            connectionInitialPreviewRef, connectionTargetNodeIdRef,
            screenToCanvas: (x: number, y: number) => { projected.push([x, y]); return { x: x / 2, y: y / 2 }; },
            setConnecting: (value: unknown) => { changes.push(value); }, setConnectionTargetNodeId: (value: unknown) => { changes.push(value); },
            setSelectedConnectionId: (value: unknown) => { changes.push(value); },
        });
        const right = pointer();
        start(right, "a", handleType);
        expect(right.stopped).toBe(true);
        expect(changes).toEqual([]);
        expect(projected).toEqual([]);
        expect(connectionInitialPreviewRef.current).toBeNull();
        expect(connectionTargetNodeIdRef.current).toBe("hovered");
        start(pointer({}, 0), "a", handleType);
        expect(projected).toEqual([[240, 160]]);
        expect(connectionInitialPreviewRef.current).toEqual({ handle: { nodeId: "a", handleType }, mouseWorld: { x: 120, y: 80 } });
        expect(changes).toEqual([{ nodeId: "a", handleType }, null, null]);
        expect(connectionTargetNodeIdRef.current).toBeNull();
    });
});

describe("actual page menu actions share their displayed selection", () => {
    test("deleting a running node requires confirmation and only stops local observation", () => {
        const page = pageHarness();
        (page.scope.generationRequestsRef as any).current.set("run", { targetNodeId: "a", originNodeId: "a", runningNodeId: "run" });
        page.remove(new Set(["a"]));
        expect(page.state.nodes).toHaveLength(3);
        expect(page.stopped).toEqual([]);
        expect(page.confirmations).toHaveLength(1);
        page.confirmations[0]!.onOk();
        expect(page.state.nodes.map(node => node.id)).toEqual(["b", "c"]);
        expect(page.stopped).toEqual([["run", true]]);
    });
    test.each([
        ["duplicate", "a", ["a", "b"]], ["delete", "a", ["a", "b"]],
        ["duplicate", "c", ["c"]], ["delete", "c", ["c"]],
    ] as const)("%s targets the displayed set for clicked node %s, including stale-selection fallback", (action, clicked, expectedIds) => {
        const page = pageHarness();
        // A stale render can still hold a,b while a menu points at c; the actual useMemo must fall back to c.
        page.state.contextMenu = { type: "node", x: 240, y: 160, nodeId: clicked };
        const menu = page.menu();
        expect(menu.ids).toEqual(new Set(expectedIds));
        expect(menu.props.targetCount).toBe(expectedIds.length);
        menu.props[action === "duplicate" ? "onDuplicate" : "onDelete"]();
        expect(page.targets[action]).toHaveLength(1);
        expect(page.targets[action][0]).toBe(menu.ids);
        expect(page.targets.connection).toEqual([]);
        if (action === "duplicate") {
            expect(page.state.nodes.slice(3).map(item => item.metadata?.storageKey)).toEqual(expectedIds.map(id => `image:${id}`));
            expect(page.state.dialogNodeId).toBe(expectedIds.length === 1 ? page.state.nodes.at(-1)!.id : null);
        } else expect(page.state.nodes.map(item => item.id)).toEqual(clicked === "a" ? ["c"] : ["a", "b"]);
        expect(page.writes.nodes).toBe(1);
        expect(page.writes.connections).toBe(1);
        expect(page.state.contextMenu).toBeNull();
        expect(page.clipboardRef.current).toBe(page.clipboard);
    });

    test("connection menus delete only the selected connection and never invoke node actions", () => {
        const page = pageHarness(undefined, undefined, [
            { id: "clicked-edge", fromNodeId: "a", toNodeId: "b" }, { id: "other-edge", fromNodeId: "b", toNodeId: "c" },
        ]);
        page.state.contextMenu = { type: "connection", x: 240, y: 160, connectionId: "clicked-edge" };
        page.state.selectedConnectionId = "clicked-edge";
        const menu = page.menu();
        expect(menu.props.targetCount).toBe(0);
        menu.props.onDuplicate();
        expect(page.writes).toEqual({});
        menu.props.onDelete();
        expect(page.targets).toEqual({ duplicate: [], delete: [], connection: ["clicked-edge"] });
        expect(page.state.connections.map(item => item.id)).toEqual(["other-edge"]);
        expect(page.state.nodes.map(item => item.id)).toEqual(["a", "b", "c"]);
        expect(page.state.selectedConnectionId).toBeNull();
        expect(page.state.contextMenu).toBeNull();
    });

    test("one real bulk duplicate appends each graph state once, remaps complete ownership and preserves the clipboard", () => {
        const originalNodes = [
            { ...node("root"), metadata: { ...node("root").metadata, isBatchRoot: true, batchChildIds: ["child"], primaryImageId: "child" } },
            { ...node("child", 100), metadata: { ...node("child").metadata, batchRootId: "root" } }, node("outside", 300),
        ];
        const originalConnections = [{ id: "inside", fromNodeId: "root", toNodeId: "child" }, { id: "outside-edge", fromNodeId: "child", toNodeId: "outside" }];
        const originalGroups = [
            { id: "complete", title: "完整款式", nodeIds: ["root", "child"], collapsed: false },
            { id: "partial", title: "部分款式", nodeIds: ["child", "outside"], collapsed: false },
        ];
        const before = structuredClone({ nodes: originalNodes, connections: originalConnections, groups: originalGroups });
        const page = pageHarness(originalNodes, ["root", "child"], originalConnections, originalGroups);
        page.duplicate(new Set(["root", "child"]));
        expect({ nodes: page.writes.nodes, connections: page.writes.connections, groups: page.writes.groups }).toEqual({ nodes: 1, connections: 1, groups: 1 });
        const [root, child] = page.state.nodes.slice(3);
        expect(root!.id).not.toBe("root");
        expect(child!.id).not.toBe("child");
        expect(page.state.nodes.slice(3).map(item => item.position)).toEqual([{ x: 36, y: 46 }, { x: 136, y: 46 }]);
        expect(root!.metadata).toMatchObject({ batchChildIds: [child!.id], primaryImageId: child!.id });
        expect(child!.metadata?.batchRootId).toBe(root!.id);
        expect(page.state.connections.slice(2)).toEqual([expect.objectContaining({ fromNodeId: root!.id, toNodeId: child!.id })]);
        expect(page.state.groups.slice(2)).toEqual([expect.objectContaining({ title: "完整款式", nodeIds: [root!.id, child!.id] })]);
        expect(page.state.selectedNodeIds).toEqual(new Set([root!.id, child!.id]));
        expect(page.state.dialogNodeId).toBeNull();
        expect(page.clipboardRef.current).toBe(page.clipboard);
        expect(page.clipboardRef.current.token).toBe("unchanged-clipboard");
        expect({ nodes: originalNodes, connections: originalConnections, groups: originalGroups }).toEqual(before);
        expect(page.cleanup).toEqual([]);
    });
});
