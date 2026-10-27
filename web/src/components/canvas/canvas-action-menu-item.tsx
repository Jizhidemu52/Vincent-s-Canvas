import type { ReactNode } from "react";
import { canvasActionHint, canvasActionLabel, canvasActionShortcut, type CanvasActionId } from "@/lib/canvas/canvas-actions";

/** Toolbar and project menus read their label, hint and shortcut from the same action. */
export function canvasActionMenuItem(id: CanvasActionId, onClick: (() => void) | undefined, icon?: ReactNode, disabled = false) {
    const shortcut = canvasActionShortcut(id);
    return {
        key: id, icon, onClick, disabled,
        danger: id === "delete" || id === "clear" || id === "deleteProject",
        label: <span data-usage-control={`canvas-tool.${id}`} title={canvasActionHint(id)}>
            {canvasActionLabel(id, "toolbar")}{shortcut && <span className="cw-menu-shortcut">{shortcut}</span>}
        </span>,
    };
}
