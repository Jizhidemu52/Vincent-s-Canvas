export const DEFAULT_AGENT_MESSAGE_WINDOW = 80;

export function agentMessageWindow(totalMessages: number, visibleLimit = DEFAULT_AGENT_MESSAGE_WINDOW) {
    const total = Math.max(0, Math.floor(totalMessages));
    const limit = Math.max(1, Math.floor(visibleLimit));
    const start = Math.max(0, total - limit);
    return { start, hidden: start };
}

export function expandAgentMessageWindow(currentLimit: number, totalMessages: number, step = DEFAULT_AGENT_MESSAGE_WINDOW) {
    const total = Math.max(0, Math.floor(totalMessages));
    const current = Math.max(1, Math.floor(currentLimit));
    return Math.min(total, current + Math.max(1, Math.floor(step)));
}
