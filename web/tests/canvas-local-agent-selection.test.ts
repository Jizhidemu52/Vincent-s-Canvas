import { expect, test } from "bun:test";
import { shallow } from "zustand/shallow";
import { selectLocalAgentPanelState } from "@/lib/canvas/canvas-local-agent-selection";
import { useCanvasAgentStore } from "@/stores/canvas/use-canvas-agent-store";

const initial = useCanvasAgentStore.getState();
const item = { id: "message", role: "assistant" as const, text: "streaming" };

test("headless local-agent selection ignores chat, log, history and layout updates but observes connection and tool controls", () => {
    const first = selectLocalAgentPanelState(initial, true);
    const stream = { ...initial, messages: [item], attachments: [], prompt: "new", eventLogs: [{ id: "log", time: "now", title: "new", text: "new" }], threads: [{ id: "thread", preview: "history" }], activeTab: "chat" as const, width: 600, activeThreadId: "other", activity: "streaming" };
    expect(shallow(first, selectLocalAgentPanelState(stream, true))).toBe(true);
    for (const patch of [{ enabled: true }, { connected: true }, { token: "new" }, { confirmTools: false }, { pendingTool: { requestId: "tool", name: "canvas_apply_ops" } }]) {
        expect(shallow(first, selectLocalAgentPanelState({ ...initial, ...patch }, true))).toBe(false);
    }
});

test("only the active local-agent view observes message and history content updates", () => {
    const setup = { ...initial, messages: [item], activeTab: "setup" as const };
    const changed = { ...setup, messages: [{ ...item, text: "next token" }] };
    expect(shallow(selectLocalAgentPanelState(setup), selectLocalAgentPanelState(changed))).toBe(true);
    expect(shallow(selectLocalAgentPanelState({ ...setup, activeTab: "chat" }), selectLocalAgentPanelState({ ...changed, activeTab: "chat" }))).toBe(false);
    expect(shallow(selectLocalAgentPanelState({ ...setup, activeTab: "log" }), selectLocalAgentPanelState({ ...changed, activeTab: "log" }))).toBe(true);
    expect(selectLocalAgentPanelState({ ...changed, activeTab: "log" }).messageCount).toBe(1);
    expect(shallow(selectLocalAgentPanelState(setup, false, true), selectLocalAgentPanelState({ ...setup, width: 600 }, false, true))).toBe(true);
});
