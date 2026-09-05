import { expect, test } from "bun:test";

import { agentMessageWindow, expandAgentMessageWindow } from "@/lib/canvas/agent-message-window";

test("keeps short conversations fully visible", () => {
    expect(agentMessageWindow(24, 80)).toEqual({ start: 0, hidden: 0 });
});

test("renders only the newest message window for a long conversation", () => {
    expect(agentMessageWindow(236, 80)).toEqual({ start: 156, hidden: 156 });
});

test("expands the rendered history in fixed windows without exceeding the message count", () => {
    expect(expandAgentMessageWindow(80, 236, 80)).toBe(160);
    expect(expandAgentMessageWindow(200, 236, 80)).toBe(236);
});
