import { forwardRef, memo, useMemo, type ComponentProps, type MouseEvent, type Ref } from "react";
import { ActiveConnectionPath, ConnectionPath, type ActiveConnectionPathHandle } from "./canvas-connections";
import { CanvasConnectionLayer, type CanvasConnectionLayerHandle } from "./canvas-connection-layer";
import { useCanvasGraphHighlight, type CanvasGraphHighlightInput } from "./use-canvas-graph-highlight";
import { selectCanvasOverviewConnections } from "@/lib/canvas/canvas-overview-connections";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

type SharedProps = { connections: CanvasConnection[]; highlight: CanvasGraphHighlightInput; overview: boolean };
export const CanvasGraphConnectionLayer = memo(forwardRef<CanvasConnectionLayerHandle, Omit<ComponentProps<typeof CanvasConnectionLayer>, "activeConnectionIds"> & SharedProps>(
    function CanvasGraphConnectionLayer({ connections, highlight, overview, ...props }, ref) {
        const { activeConnectionIds } = useCanvasGraphHighlight(highlight);
        const visible = useMemo(() => overview ? selectCanvasOverviewConnections(connections, activeConnectionIds) : connections, [connections, overview, activeConnectionIds]);
        return <CanvasConnectionLayer ref={ref} {...props} connections={visible} activeConnectionIds={activeConnectionIds} />;
    },
));
export const CanvasConnectionSvg = memo(function CanvasConnectionSvg({ kind, connections, highlight, overview, resolveNode, activeRef, onSelect, onContextMenu }: SharedProps & {
    kind: "fallback" | "preview" | null;
    resolveNode: (id: string) => CanvasNodeData | undefined;
    activeRef: Ref<ActiveConnectionPathHandle>;
    onSelect: (connection: CanvasConnection) => void;
    onContextMenu: (event: MouseEvent, connection: CanvasConnection) => void;
}) {
    const { activeConnectionIds } = useCanvasGraphHighlight(highlight);
    const visible = useMemo(() => overview ? selectCanvasOverviewConnections(connections, activeConnectionIds) : connections, [connections, overview, activeConnectionIds]);
    if (kind === null) return null;
    return <svg className={kind === "fallback" ? "absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" : "absolute left-0 top-0 size-px overflow-visible"} style={{ pointerEvents: "none", zIndex: 0 }}>
        {kind === "fallback" ? visible.map(connection => {
            const from = resolveNode(connection.fromNodeId), to = resolveNode(connection.toNodeId);
            return from && to ? <ConnectionPath key={connection.id} connection={connection} from={from} to={to}
                active={activeConnectionIds.has(connection.id)} renderVisual
                onSelect={() => onSelect(connection)} onContextMenu={event => onContextMenu(event, connection)} /> : null;
        }) : null}
        <ActiveConnectionPath ref={activeRef} />
    </svg>;
});
