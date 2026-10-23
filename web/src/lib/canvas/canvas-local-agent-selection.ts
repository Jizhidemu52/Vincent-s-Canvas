import type { useCanvasAgentStore, AgentAttachment, AgentChatItem, AgentEventLog, AgentThreadSummary } from "@/stores/canvas/use-canvas-agent-store";

type AgentState = ReturnType<typeof useCanvasAgentStore.getState>;
const noAttachments: AgentAttachment[] = [];
const noMessages: AgentChatItem[] = [];
const noLogs: AgentEventLog[] = [];
const noThreads: AgentThreadSummary[] = [];

/** Keep connection controls live without subscribing hidden views to stream content. */
export function selectLocalAgentPanelState(state: AgentState, headless = false, embedded = false) {
    const tab = headless ? "setup" : state.activeTab;
    const chat = !headless && tab === "chat";
    const log = !headless && tab === "log";
    const history = !headless && tab === "history";
    return {
        url: state.url, token: state.token, enabled: state.enabled, connected: state.connected,
        confirmTools: state.confirmTools, pendingTool: state.pendingTool,
        width: headless || embedded ? 0 : state.width,
        activeTab: tab, activeThreadId: headless ? "" : state.activeThreadId,
        prompt: chat ? state.prompt : "", attachments: chat ? state.attachments : noAttachments,
        sending: chat || log ? state.sending : false, waiting: chat || log ? state.waiting : false,
        messages: chat ? state.messages : noMessages, messageCount: log ? state.messages.length : 0,
        eventLogs: log ? state.eventLogs : noLogs, eventLogCount: headless ? 0 : state.eventLogs.length,
        threads: history ? state.threads : noThreads, threadCount: headless ? 0 : state.threads.length,
        workspacePath: history ? state.workspacePath : "", loadingThreads: history ? state.loadingThreads : false,
        activity: !headless && (tab === "setup" || log) ? state.activity : "",
        connectError: !headless && tab === "setup" ? state.connectError : "",
        setAgentState: state.setAgentState, addMessage: state.addMessage, addEventLog: state.addEventLog, clearEventLogs: state.clearEventLogs,
    };
}
