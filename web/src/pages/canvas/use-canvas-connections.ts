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
import { canvasConnectionCreateOptions } from "@/lib/canvas/canvas-connection-create-options";
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
    const [invalidConnectionTargetNodeId, setInvalidConnectionTargetNodeId] = useState<string | null>(null);
    const [connectionTargetReason, setConnectionTargetReason] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const connectionPreviewFrameRef = useRef<number | null>(null);
    const connectionPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
    const connectionStartRef = useRef<{ clientX: number; clientY: number } | null>(null);
    const connectionInitialPreviewRef = useRef<{ handle: ConnectionHandle; mouseWorld: Position } | null>(null);
    const activeConnectionPathRef = useRef<ActiveConnectionPathHandle>(null);
    const connectingParamsRef = useRef(connectingParams);
    const reconnectingIdRef = useRef<string | null>(null);
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
            reconnectingIdRef.current = null;
            if (connectionPreviewFrameRef.current) {
                cancelAnimationFrame(connectionPreviewFrameRef.current);
                connectionPreviewFrameRef.current = null;
            }
            connectionPointerRef.current = null;
            connectionStartRef.current = null;
            connectionInitialPreviewRef.current = null;
            activeConnectionPathRef.current?.clear();
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setInvalidConnectionTargetNodeId(null);
            setConnectionTargetReason(null);
        }
    }, []);

    const connectionError = useCallback((current: ConnectionHandle, targetNodeId: string) => {
        if (current.nodeId === targetNodeId) return uiText("不能连接节点自身");
        const connection = normalizeConnection(current.nodeId, targetNodeId, nodesRef.current, current.handleType);
        if (!connection) return uiText("工作流中间步骤需为生图，最后一步支持生图、文本或视频");
        if ([...generationDispatchLocksRef.current].some(key => key.startsWith("image-sequence:"))) return uiText("请先停止工作流，再修改连线");
        const edges = connectionsRef.current.filter(edge => edge.id !== reconnectingIdRef.current);
        if (reconnectingIdRef.current && edges.some(edge => edge.fromNodeId === connection.fromNodeId && edge.toNodeId === connection.toNodeId)) return uiText("这两个节点已经连接，请选择其他节点");
        const workflowError = imageWorkflowConnectionError(connection, edges);
        if (workflowError) return workflowError;
        if (connection.kind === "config-target" && edges.some(edge => edge.kind === "config-target" && edge.toNodeId === connection.toNodeId && edge.fromNodeId !== connection.fromNodeId)) return uiText("一个任务只能使用一套公共配置，请先断开原配置连线");
        return null;
    }, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, targetNodeId: string) => {
            const error = connectionError(current, targetNodeId);
            if (error) { message.warning(error); return; }
            const connection = normalizeConnection(current.nodeId, targetNodeId, nodesRef.current, current.handleType);
            if (!connection) return;
            const { fromNodeId, toNodeId } = connection;
            flushPendingHistory();
            const reconnectingId = reconnectingIdRef.current;
            if (reconnectingId) {
                setConnections(prev => prev.map(edge => edge.id === reconnectingId ? { ...edge, ...connection } : edge));
                setSelectedConnectionId(reconnectingId);
                setContextMenu(null);
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
        [connectionError, flushPendingHistory, message],
    );

    const createConnectedNode = useCallback(
        (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio, pending: PendingConnectionCreate) => {
            if ([...generationDispatchLocksRef.current].some(key => key.startsWith("image-sequence:"))) { message.info(uiText("请先停止工作流，再修改连线")); return; }
            const sourceNode = nodesRef.current.find(node => node.id === pending.connection.nodeId);
            const option = canvasConnectionCreateOptions(sourceNode, pending.connection.handleType).find(item => item.type === type);
            if (!option) { message.info(uiText("当前节点不支持这种连接，请重新选择。")); return; }
            const mode = option.configMode || "image";
            const model = mode === "video" ? effectiveConfig.videoModel : mode === "audio" ? effectiveConfig.audioModel : mode === "text" ? effectiveConfig.textModel : effectiveConfig.imageModel || effectiveConfig.model;
            const metadata = type === CanvasNodeType.Config ? { model, generationMode: mode, size: effectiveConfig.size, count: 1 } : undefined;
            const newNode = createCanvasNode(type, pending.position, metadata);
            const connection = normalizeConnection(pending.connection.nodeId, newNode.id, [...nodesRef.current, newNode], pending.connection.handleType);
            if (!connection) {
                message.warning(uiText("工作流只支持生图配置，请把上一步配置设为生图"));
                return;
            }
            flushPendingHistory();
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio) setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [effectiveConfig.audioModel, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, effectiveConfig.textModel, effectiveConfig.videoModel, flushPendingHistory, message, setConnecting],
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
                canConnect: (node) => !connectionError(current, node.id),
                isHiddenNode: (node) => hiddenGroupNodeIds.has(node.id) || isCanvasBatchChildHidden(node, batchRootsById),
            });
        },
        [batchRootsById, canvasSpatialIndex, connectionError, hiddenGroupNodeIds, screenToCanvas],
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
            setInvalidConnectionTargetNodeId(dropTarget.invalidNodeId || null);
            setConnectionTargetReason(dropTarget.invalidNodeId ? connectionError(current, dropTarget.invalidNodeId) : null);
            const mouseWorld = screenToCanvas(clientX, clientY);
            activeConnectionPathRef.current?.draw(resolveRenderNode(current.nodeId), current, mouseWorld, dropTarget.nodeId ? resolveRenderNode(dropTarget.nodeId) : undefined);
        },
        [connectionError, getConnectionDropTarget, resolveRenderNode, screenToCanvas],
    );

    const scheduleConnectionPointer = useCallback(
        (clientX: number, clientY: number) => {
            connectionPointerRef.current = { clientX, clientY };
            if (connectionPreviewFrameRef.current) return;
            connectionPreviewFrameRef.current = requestAnimationFrame(() => {
                connectionPreviewFrameRef.current = null;
                const pointer = connectionPointerRef.current;
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
            event.preventDefault();
            const previous = connectingParamsRef.current;
            if (previous && previous.nodeId !== nodeId) {
                connectNodes(previous, nodeId);
                setConnecting(null);
                return;
            }
            const connection = { nodeId, handleType } as ConnectionHandle;
            const mouseWorld = screenToCanvas(event.clientX, event.clientY);
            connectionInitialPreviewRef.current = { handle: connection, mouseWorld };
            setConnecting(connection);
            connectionStartRef.current = { clientX: event.clientX, clientY: event.clientY };
            connectionPointerRef.current = connectionStartRef.current;
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setSelectedConnectionId(null);
        },
        [connectNodes, screenToCanvas, setConnecting],
    );

    const deleteConnection = useCallback((connectionId: string) => {
        if ([...generationDispatchLocksRef.current].some(key => key.startsWith("image-sequence:"))) { message.info(uiText("请先停止工作流，再修改连线")); return; }
        flushPendingHistory();
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, [flushPendingHistory, message]);

    const handleReconnectStart = useCallback((event: ReactPointerEvent, edge: CanvasConnection, endpoint: "source" | "target") => {
        event.preventDefault(); event.stopPropagation();
        if (event.button !== 0) return;
        if ([...generationDispatchLocksRef.current].some(key => key.startsWith("image-sequence:"))) { message.info(uiText("请先停止工作流，再修改连线")); return; }
        setConnecting(null);
        reconnectingIdRef.current = edge.id;
        const current: ConnectionHandle = endpoint === "source"
            ? { nodeId: edge.toNodeId, handleType: "target" }
            : { nodeId: edge.fromNodeId, handleType: "source" };
        connectionInitialPreviewRef.current = { handle: current, mouseWorld: screenToCanvas(event.clientX, event.clientY) };
        connectionPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
        // A rewire always finishes on release, including a click without motion.
        connectionStartRef.current = null;
        setConnecting(current);
        setPendingConnectionCreate(null);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(edge.id);
        event.currentTarget.setPointerCapture(event.pointerId);
    }, [message, screenToCanvas, setConnecting]);

    const finishConnection = useCallback((clientX: number, clientY: number) => {
        flushConnectionPointer();
        if (pendingConnectionCreateRef.current) return;

        const currentConnection = connectingParamsRef.current;
        if (currentConnection) {
            const start = connectionStartRef.current;
            connectionStartRef.current = null;
            // A click on a port starts click-to-connect; dragging still finishes
            // on release. The second click is resolved against the same rules.
            if (start && Math.hypot(clientX - start.clientX, clientY - start.clientY) < 4) return;
            const dropTarget = getConnectionDropTarget(clientX, clientY, currentConnection);
            if (dropTarget.nodeId) {
                connectNodes(currentConnection, dropTarget.nodeId);
                setConnecting(null);
            } else if (dropTarget.isNearNode) {
                if (dropTarget.invalidNodeId) message.warning(connectionError(currentConnection, dropTarget.invalidNodeId));
                setConnecting(null);
            } else if (reconnectingIdRef.current) {
                setConnecting(null);
            } else {
                const position = screenToCanvas(clientX, clientY);
                activeConnectionPathRef.current?.clear();
                setPendingConnectionCreate({ connection: currentConnection, position });
            }
        }
    }, [connectNodes, connectionError, flushConnectionPointer, getConnectionDropTarget, message, screenToCanvas, setConnecting]);

    const moveConnection = useCallback((clientX: number, clientY: number) => {
        if (connectingParamsRef.current && !pendingConnectionCreateRef.current) scheduleConnectionPointer(clientX, clientY);
    }, [scheduleConnectionPointer]);

    const refreshConnectionPreview = useCallback(() => {
        const pointer = connectionPointerRef.current;
        if (pointer && connectingParamsRef.current) applyConnectionPointer(pointer.clientX, pointer.clientY);
    }, [applyConnectionPointer]);

    const connectionTargetHint = connectingParams && connectionTargetNodeId
        ? (() => {
            const edge = normalizeConnection(connectingParams.nodeId, connectionTargetNodeId, nodesRef.current, connectingParams.handleType);
            return edge?.kind === "config-sequence" ? uiText("作为上一步") : edge?.kind === "config-target" ? uiText("使用公共配置") : uiText("作为输入参考");
        })() : null;
    const canConnectNode = (id: string) => Boolean(connectingParams && !connectionError(connectingParams, id));

    return {
        connectingParams, connectionTargetNodeId, invalidConnectionTargetNodeId, connectionTargetReason, pendingConnectionCreate,
        pendingConnectionCreateRef, activeConnectionPathRef, setConnecting,
        createConnectedNode, cancelPendingConnectionCreate, findConnectionAtClientPoint,
        handleConnectionPointerDown, moveConnection, finishConnection,
        deleteConnection, handleConnectStart, handleReconnectStart, refreshConnectionPreview, canConnectNode, connectionTargetHint,
    };
}
