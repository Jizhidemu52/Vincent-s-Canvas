import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentChatMessage, AgentPendingToolCard, AgentToolCard } from "@/components/canvas/canvas-agent-chat-ui";
import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasAgentStore } from "@/stores/canvas/use-canvas-agent-store";
import { useUserStore, type LocalUser } from "@/stores/use-user-store";

const initialAgent = useCanvasAgentStore.getInitialState();
const initialUser = useUserStore.getInitialState();
const savedAgent = { ...initialAgent }, savedUser = { ...initialUser };
const savedCurrentUser = useUserStore.getState().user;
afterEach(() => { Object.assign(initialAgent, savedAgent); Object.assign(initialUser, savedUser); useUserStore.setState({ user: savedCurrentUser }); });
function enableDetails(role: LocalUser["role"] = "super_admin", enabled = true) {
    initialUser.user = { role } as LocalUser;
    // SSR hooks read the initial snapshot; metadata helpers read getState().
    useUserStore.setState({ user: initialUser.user });
    initialAgent.showToolDetails = enabled;
}

const signature = "opaque-continuation-signature-that-must-not-render";
const detail = {
    status: "pending",
    generationSettings: { mode: "image", imageModel: "gpt-image-2", imageCount: "2", size: "1:1", quality: "2k" },
    referenceImages: [{ id: "reference-1", title: "原款图" }],
    toolCalls: [{ id: "call-1", thoughtSignature: signature, function: { name: "canvas_generate_image", arguments: JSON.stringify({ prompt: "将花瓶改成绿色，保留原图细节" }) } }],
};

describe("Agent tool confirmation details", () => {
    test("online confirmations and developer details are opt-in without changing local agent confirmation", () => {
        expect(initialAgent.onlineConfirmTools).toBe(false);
        expect(initialAgent.showToolDetails).toBe(false);
        expect(initialAgent.confirmTools).toBe(true);
    });

    test.each(["designer", "department_admin", "super_admin"] as const)("%s sees readable deletion objects but no JSON by default", role => {
        enableDetails(role, false);
        const markup = renderToStaticMarkup(<AgentPendingToolCard summary="删除选中的说明" detail={{ ...detail, preview: [{ destructive: true, count: 1, nodes: [{ id: "delete-this", title: "针织说明" }] }] }} theme={canvasThemes.light} onApprove={() => undefined} onReject={() => undefined} />);
        expect(markup).toContain("删除选中的说明");
        expect(markup).toContain("将删除 1 个对象");
        expect(markup).toContain("针织说明");
        expect(markup).toContain("批准执行");
        expect(markup).toContain("拒绝执行");
        expect(markup).not.toContain("<pre");
        expect(markup).not.toContain("<details");
        expect(markup).not.toContain("详情");
        expect(markup).not.toContain("canvas_generate_image");
    });

    test.each(["designer", "department_admin"] as const)("%s cannot inherit an administrator's detail opt-in", role => {
        enableDetails(role);
        for (const markup of [
            renderToStaticMarkup(<AgentPendingToolCard summary="请确认" detail={detail} theme={canvasThemes.light} />),
            renderToStaticMarkup(<AgentToolCard title="已完成" text="内容保留" detail={detail} theme={canvasThemes.light} />),
        ]) {
            expect(markup).not.toContain("<pre");
            expect(markup).not.toContain("<details");
            expect(markup).not.toContain("canvas_generate_image");
        }
    });

    test("shows effective generation inputs without exposing or mutating protocol signatures", () => {
        enableDetails();
        const original = JSON.stringify(detail);
        const markup = renderToStaticMarkup(<AgentPendingToolCard summary="生成图片" detail={detail} theme={canvasThemes.light} />);
        expect(markup).not.toContain(signature);
        expect(markup).not.toContain("thoughtSignature");
        expect(markup).toContain("将花瓶改成绿色，保留原图细节");
        expect(markup).toContain("gpt-image-2");
        expect(markup).toContain("原款图");
        expect(markup).toContain("2k");
        expect(JSON.stringify(detail)).toBe(original);
    });

    test("hides nested signature metadata in legacy/local tool details", () => {
        enableDetails();
        const markup = renderToStaticMarkup(<AgentToolCard title="工具执行完成" text="完成" detail={{ name: "canvas_apply_ops", input: { thought_signature: signature, ops: [{ type: "delete_node", id: "review-this-node" }] } }} theme={canvasThemes.light} />);
        expect(markup).not.toContain(signature);
        expect(markup).not.toContain("thought_signature");
        expect(markup).toContain("delete_node");
        expect(markup).toContain("review-this-node");
    });

    test("renders a running confirmation with both actions disabled", () => {
        const markup = renderToStaticMarkup(<AgentChatMessage item={{ id: "running-tool", role: "tool", text: "生成绿色花瓶", detail: { ...detail, status: "running" } }} user={null} theme={canvasThemes.light} onRejectTool={() => undefined} onApproveTool={() => undefined} />);
        expect(markup).toContain("执行中");
        expect((markup.match(/<button[^>]*disabled=""/g) || []).length).toBe(2);
        expect(markup).not.toContain("等待确认");
    });
});
