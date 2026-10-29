import { uiText } from "@/lib/i18n";
import type { ActiveConnectionPathHandle } from "@/components/canvas/canvas-connections";
import { createCanvasBatchRenderIndex } from "@/lib/canvas/canvas-batch-motion";
import { isCanvasBatchChildHidden } from "@/lib/canvas/canvas-batch-visibility";
import { findCanvasConnectionDropTarget, type CanvasConnectionDropTarget } from "@/lib/canvas/canvas-connection-drop-target";
import { findCanvasConnectionHit } from "@/lib/canvas/canvas-connection-hit-test";
import { imageWorkflowConnectionError, normalizeCanvasConnection } from "@/lib/canvas/canvas-shared-connections";
import { createCanvasSpatialIndex } from "@/lib/canvas/canvas-spatial-index";
import { useCanvasGraphSetter } from "@/stores/canvas/canvas-graph-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ConnectionHandle, type ContextMenuState, type Position, type ViewportTransform } from "@/types/canvas";
import { App } from "antd";
import { nanoid } from "nanoid";
import type { Dispatch, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createCanvasNode } from "./canvas-project-utils";
type CanvasConnectionsOptions = {
    nodesRef: RefObject<CanvasNodeData[]>;
    connectionsRef: RefObject<CanvasConnection[]>;
    viewportRef: RefObject<ViewportTransform>;
    generationDispatchLocksRef: RefObject<Set<string>>;
    screenToCanvas: (clientX: number, clientY: number) => Position;
    setDialogNodeId: Dispatch<SetStateAction<string | null>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
    flushPendingHistory: () => unknown;
    geometry: {
        nodeById: ReadonlyMap<string, CanvasNodeData>;
        visibleConnections: CanvasConnection[];
        canvasSpatialIndex: ReturnType<typeof createCanvasSpatialIndex>;
        batchRootsById: ReturnType<typeof createCanvasBatchRenderIndex>["rootsById"];
        hiddenGroupNodeIds: ReadonlySet<string>;
        resolveRenderNode: (nodeId: string) => CanvasNodeData | undefined;
    };
};

type PendingConnectionCreate = {
    connection: ConnectionHandle;
    position: Position;
};

function normalizeConnection(firstNodeId: string, secondNodeId: string, nodes: CanvasNodeData[], firstHandleType: "source" | "target") {
    const first = nodes.find((node) => node.id === firstNodeId);
    const second = nodes.find((node) => node.id === secondNodeId);
    return first && second ? normalizeCanvasConnection(first, second, firstHandleType) : null;
}

export function useCanvasConnections({ nodesRef, connectionsRef, viewportRef, generationDispatchLocksRef, screenToCanvas, setDialogNodeId, setContextMenu, flushPendingHistory, geometry }: CanvasConnectionsOptions) {
    const { message } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const setNodes = useCanvasGraphSetter("nodes");
    const setConnections = useCanvasGraphSetter("connections");
    const setSelectedNodeIds = useCanvasGraphSetter("selectedNodeIds");
    const setSelectedConnectionId = useCanvasGraphSetter("selectedConnectionId");
    const { nodeById, visibleConnections, canvasSpatialIndex, batchRootsById, hiddenGroupNodeIds, resolveRenderNode } = geometry;
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const connectionPreviewFrameRef = useRef<number | null>(null);
    const connectionPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
    const connectionInitialPreviewRef = useRef<{ handle: ConnectionHandle; mouseWorld: Position } | null>(null);
    const activeConnectionPathRef = useRef<ActiveConnectionPathHandle>(null);
    const connectingParamsRef = useRef(connectingParams);
    const connectionTargetNodeIdRef = useRef(connectionTargetNodeId);
    const pendingConnectionCreateRef = useRef(pendingConnectionCreate);

    useLayoutEffect(() => {
        connectingParamsRef.current = connectingParams;
        connectionTargetNodeIdRef.current = connectionTargetNodeId;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
    }, [connectingParams, connectionTargetNodeId, pendingConnectionCreate]);

    const setConnecting = useCallback((next: ConnectionHandle | null) => {
        connectingParamsRef.current = next;
        setConnectingParams(next);
        if (!next) {
            if (connectionPreviewFrameRef.current) {
                cancelAnimationFrame(connectionPreviewFrameRef.current);
                connectionPreviewFrameRef.current = null;
            }
            connectionPointerRef.current = null;
            connectionInitialPreviewRef.current = null;
            activeConnectionPathRef.current?.clear();
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
        }
    }, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, targetNodeId: string) => {
            if (current.nodeId === targetNodeId) return;

            const connection = normalizeConnection(current.nodeId, targetNodeId, nodesRef.current, current.handleType);
            if (!connection) {
                message.warning(uiText("当前支持生图配置之间的工作流连接，请把两个配置都设为生图"));
                return;
            }
            if ([...generationDispatchLocksRef.current].some(key => key.startsWith("image-sequence:"))) { message.info(uiText("请先停止工作流，再修改连线")); return; }
            const workflowError = imageWorkflowConnectionError(connection, connectionsRef.current);
            if (workflowError) { message.warning(workflowError); return; }
            const { fromNodeId, toNodeId } = connection;
            if (connection.kind === "config-target" && connectionsRef.current.some((edge) => edge.kind === "config-target" && edge.toNodeId === toNodeId && edge.fromNodeId !== fromNodeId)) {
                message.warning(uiText("一个任务只能使用一套公共配置，请先断开原配置连线"));
                return;
            }
            const exists = connectionsRef.current.some((conn) => conn.fromNodeId === fromNodeId && conn.toNodeId === toNodeId);
            if (!exists) {
                setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            } else if (connection.kind) {
                setConnections((prev) => prev.map((edge) => edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId ? { ...edge, kind: connection.kind } : edge));
            }
            setContextMenu(null);
        },
        [message],
    );

    const createConnectedNode = useCallback(
        (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio, pending: PendingConnectionCreate) => {
            if ([...generationDispatchLocksRef.current].some(key => key.startsWith("image-sequence:"))) { message.info(uiText("请先停止工作流，再修改连线")); return; }
            const metadata = type === CanvasNodeType.Config ? { model: effectiveConfig.imageModel || effectiveConfig.model, generationMode: "image" as const, size: effectiveConfig.size, count: 1 } : undefined;
            const newNode = createCanvasNode(type, pending.position, metadata);
            const connection = normalizeConnection(pending.connection.nodeId, newNode.id, [...nodesRef.current, newNode], pending.connection.handleType);
            if (!connection) {
                message.warning(uiText("工作流只支持生图配置，请把上一步配置设为生图"));
                return;
            }
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio) setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, setConnecting],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
        setConnecting(null);
    }, [setConnecting]);

    const getConnectionDropTarget = useCallback(
        (clientX: number, clientY: number, current: ConnectionHandle): CanvasConnectionDropTarget => {
            const world = screenToCanvas(clientX, clientY);
            return findCanvasConnectionDropTarget({
                index: canvasSpatialIndex,
                world,
                current,
                scale: viewportRef.current.k,
                canConnect: (node) => Boolean(normalizeConnection(current.nodeId, node.id, nodesRef.current, current.handleType)),
                isHiddenNode: (node) => hiddenGroupNodeIds.has(node.id) || isCanvasBatchChildHidden(node, batchRootsById),
            });
        },
        [batchRootsById, canvasSpatialIndex, hiddenGroupNodeIds, screenToCanvas],
    );

    useLayoutEffect(() => {
        const preview = connectionInitialPreviewRef.current;
        if (!connectingParams || !preview) return;
        activeConnectionPathRef.current?.draw(resolveRenderNode(connectingParams.nodeId), preview.handle, preview.mouseWorld);
    }, [connectingParams, resolveRenderNode]);

    const findConnectionAtClientPoint = useCallback(
        (clientX: number, clientY: number) =>
            findCanvasConnectionHit({
                connections: visibleConnections,
                nodeById,
                world: screenToCanvas(clientX, clientY),
                tolerance: 10 / viewportRef.current.k,
            }),
        [nodeById, screenToCanvas, visibleConnections],
    );

    const handleConnectionPointerDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            const connection = findConnectionAtClientPoint(event.clientX, event.clientY);
            if (!connection) return false;

            setSelectedConnectionId(connection.id);
            setSelectedNodeIds(new Set());
            setContextMenu(null);
            return true;
        },
        [findConnectionAtClientPoint],
    );

    const applyConnectionPointer = useCallback(
        (clientX: number, clientY: number) => {
            const current = connectingParamsRef.current;
            if (!current || pendingConnectionCreateRef.current) return;

            const dropTarget = getConnectionDropTarget(clientX, clientY, current);
            if (connectionTargetNodeIdRef.current !== dropTarget.nodeId) {
                connectionTargetNodeIdRef.current = dropTarget.nodeId;
                setConnectionTargetNodeId(dropTarget.nodeId);
            }
            const mouseWorld = screenToCanvas(clientX, clientY);
            activeConnectionPathRef.current?.draw(resolveRenderNode(current.nodeId), current, mouseWorld, dropTarget.nodeId ? resolveRenderNode(dropTarget.nodeId) : undefined);
        },
        [getConnectionDropTarget, resolveRenderNode, screenToCanvas],
    );

    const scheduleConnectionPointer = useCallback(
        (clientX: number, clientY: number) => {
            connectionPointerRef.current = { clientX, clientY };
            if (connectionPreviewFrameRef.current) return;
            connectionPreviewFrameRef.current = requestAnimationFrame(() => {
                connectionPreviewFrameRef.current = null;
                const pointer = connectionPointerRef.current;
                connectionPointerRef.current = null;
                if (pointer) applyConnectionPointer(pointer.clientX, pointer.clientY);
            });
        },
        [applyConnectionPointer],
    );

    const flushConnectionPointer = useCallback(() => {
        if (connectionPreviewFrameRef.current) {
            cancelAnimationFrame(connectionPreviewFrameRef.current);
            connectionPreviewFrameRef.current = null;
        }
        const pointer = connectionPointerRef.current;
        connectionPointerRef.current = null;
        if (pointer) applyConnectionPointer(pointer.clientX, pointer.clientY);
    }, [applyConnectionPointer]);

    useEffect(
        () => () => {
            if (connectionPreviewFrameRef.current) cancelAnimationFrame(connectionPreviewFrameRef.current);
        },
        [],
    );

    const handleConnectStart = useCallback(
        (event: ReactMouseEvent, nodeId: string, handleType: "source" | "target") => {
            event.stopPropagation();
            if (event.button !== 0) return;
            const connection = { nodeId, handleType } as ConnectionHandle;
            const mouseWorld = screenToCanvas(event.clientX, event.clientY);
            connectionInitialPreviewRef.current = { handle: connection, mouseWorld };
            setConnecting(connection);
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setSelectedConnectionId(null);
        },
        [screenToCanvas, setConnecting],
    );

    const deleteConnection = useCallback((connectionId: string) => {
        if ([...generationDispatchLocksRef.current].some(key => key.startsWith("image-sequence:"))) { message.info(uiText("请先停止工作流，再修改连线")); return; }
        flushPendingHistory();
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, [flushPendingHistory, message]);

    const finishConnection = useCallback((clientX: number, clientY: number) => {
        flushConnectionPointer();
        if (pendingConnectionCreateRef.current) return;

        const currentConnection = connectingParamsRef.current;
        if (currentConnection) {
            const dropTarget = getConnectionDropTarget(clientX, clientY, currentConnection);
            if (dropTarget.nodeId) {
                connectNodes(currentConnection, dropTarget.nodeId);
                setConnecting(null);
            } else if (dropTarget.isNearNode) {
                setConnecting(null);
            } else {
                const position = screenToCanvas(clientX, clientY);
                activeConnectionPathRef.current?.clear();
                setPendingConnectionCreate({ connection: currentConnection, position });
            }
        }
    }, [connectNodes, flushConnectionPointer, getConnectionDropTarget, screenToCanvas, setConnecting]);

    const moveConnection = useCallback((clientX: number, clientY: number) => {
        if (connectingParamsRef.current && !pendingConnectionCreateRef.current) scheduleConnectionPointer(clientX, clientY);
    }, [scheduleConnectionPointer]);

    return {
        connectingParams, connectionTargetNodeId, pendingConnectionCreate,
        pendingConnectionCreateRef, activeConnectionPathRef, setConnecting,
        createConnectedNode, cancelPendingConnectionCreate, findConnectionAtClientPoint,
        handleConnectionPointerDown, moveConnection, finishConnection,
        deleteConnection, handleConnectStart,
    };
}
