import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentChatMessage, AgentPendingToolCard, AgentToolCard } from "@/components/canvas/canvas-agent-chat-ui";
import { canvasThemes } from "@/lib/canvas-theme";

const signature = "opaque-continuation-signature-that-must-not-render";
const detail = {
    status: "pending",
    generationSettings: { mode: "image", imageModel: "gpt-image-2", imageCount: "2", size: "1:1", quality: "2k" },
    referenceImages: [{ id: "reference-1", title: "原款图" }],
    toolCalls: [{ id: "call-1", thoughtSignature: signature, function: { name: "canvas_generate_image", arguments: JSON.stringify({ prompt: "将花瓶改成绿色，保留原图细节" }) } }],
};

describe("Agent tool confirmation details", () => {
    test("shows effective generation inputs without exposing or mutating protocol signatures", () => {
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
