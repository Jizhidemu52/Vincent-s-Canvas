export type CanvasCompactAgentStatus = {
    connected: boolean;
    enabled: boolean;
    activity: string;
};

export type CanvasTopBarRenderState = {
    title: string;
    titleDraft: string;
    isTitleEditing: boolean;
    onTitleDraftChange: (value: string) => void;
    onStartTitleEditing: () => void;
    onFinishTitleEditing: () => void;
    onCancelTitleEditing: () => void;
    canUndo: boolean;
    canRedo: boolean;
    onHome: () => void;
    onProjects: () => void;
    onCreateProject: () => void;
    onDeleteProject: () => void;
    onImportImage: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onExport: () => void;
    onExportImages?: () => void;
    onShare: () => void;
    agentOpen: boolean;
    compactAgentStatus?: CanvasCompactAgentStatus;
    onToggleAgent: () => void;
};

function compactAgentStatusEqual(previous?: CanvasCompactAgentStatus, next?: CanvasCompactAgentStatus) {
    return previous === next || Boolean(previous && next && previous.connected === next.connected && previous.enabled === next.enabled && previous.activity === next.activity);
}

/**
 * Node drag and resize previews refresh the canvas page at frame rate. The
 * workspace header has no preview-dependent output, so keep it mounted until
 * a visible header value or one of its action closures changes.
 */
export function canvasTopBarPropsEqual(previous: CanvasTopBarRenderState, next: CanvasTopBarRenderState) {
    return (
        previous.title === next.title &&
        previous.titleDraft === next.titleDraft &&
        previous.isTitleEditing === next.isTitleEditing &&
        previous.onTitleDraftChange === next.onTitleDraftChange &&
        previous.onStartTitleEditing === next.onStartTitleEditing &&
        previous.onFinishTitleEditing === next.onFinishTitleEditing &&
        previous.onCancelTitleEditing === next.onCancelTitleEditing &&
        previous.canUndo === next.canUndo &&
        previous.canRedo === next.canRedo &&
        previous.onHome === next.onHome &&
        previous.onProjects === next.onProjects &&
        previous.onCreateProject === next.onCreateProject &&
        previous.onDeleteProject === next.onDeleteProject &&
        previous.onImportImage === next.onImportImage &&
        previous.onUndo === next.onUndo &&
        previous.onRedo === next.onRedo &&
        previous.onExport === next.onExport &&
        previous.onExportImages === next.onExportImages &&
        previous.onShare === next.onShare &&
        previous.agentOpen === next.agentOpen &&
        compactAgentStatusEqual(previous.compactAgentStatus, next.compactAgentStatus) &&
        previous.onToggleAgent === next.onToggleAgent
    );
}
