import { expect, test } from "bun:test";
import { buildCreativeChatRequest, buildCreativeImageCatalog } from "@/lib/creative-chat";
import { confirmedDesignRequirements, parseAgentDocumentTool } from "@/lib/image-agent/document-tools";
import { createChatBranch } from "@/pages/chat/chat-message-actions";
import { portableCanvasMedia } from "@/lib/canvas/canvas-portable-media";
import { collectChatImageReferences } from "@/services/chat-history-references";
import { chatImageTaskSignature } from "@/pages/chat/chat-image-tasks";
import type { AgentDocument, DesignRequirementCard } from "../../shared/image-agent-documents";
import type { ChatSession } from "@/pages/chat/chat-types";

const document: AgentDocument = { id: "brief", name: "设计需求.pdf", kind: "pdf", mimeType: "application/pdf", bytes: 10,
    source: { name: "设计需求.pdf", mimeType: "application/pdf", dataUrl: "", storageKey: "document:original" },
    sections: [{ id: "brief-p1", title: "第1页", text: "红色开衫，禁止口袋", figureIds: ["brief-f1"] }],
    figures: [{ id: "brief-f1", label: "文件图1", sectionId: "brief-p1", name: "第1页.png", mimeType: "image/png", dataUrl: "", storageKey: "image:page" }], warnings: ["扫描页请按图核对"] };
const card: DesignRequirementCard = { id: "card", title: "开衫", status: "confirmed", updatedAt: "2026-11-06", documentIds: ["brief"], subject: "红色开衫", colors: "红色", materials: "毛线", must: ["保留5粒纽扣"], avoid: ["口袋"], unknowns: ["袖长未注明"], referenceFigureIds: ["brief-f1"], sources: [{ documentId: "brief", sectionId: "brief-p1" }] };
const call = (name: string, args: unknown) => ({ content: "", toolCalls: [{ id: "call", type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });

test("document catalog and confirmed card survive history trimming without exposing original bytes or becoming a base", async () => {
    const history = Array.from({ length: 40 }, (_, index) => ({ id: `m${index}`, role: "user" as const, content: `旧消息${index}` + "无关".repeat(3000) }));
    const prepared = await buildCreativeChatRequest(history, { role: "user", content: "按需求做一版" }, [], { documents: [document], requirements: confirmedDesignRequirements(card) });
    expect(prepared.profileContext.documentCatalog[0].sections).toEqual([{ id: "brief-p1", figureIds: ["brief-f1"] }]);
    expect(prepared.profileContext.requirements?.avoid).toEqual(["口袋"]);
    expect(prepared.messages.at(-1)?.content).toBe("按需求做一版");
    expect(JSON.stringify(prepared.messages)).toContain("红色开衫，禁止口袋");
    expect(JSON.stringify(prepared.messages)).not.toContain("document:original");
    expect(prepared.profileContext.imageCatalog).toEqual([]);
    expect(buildCreativeImageCatalog([], { role: "user", content: "", attachments: [{ id: "doc", name: document.name, kind: "text", mimeType: "application/pdf" }] })).toEqual([]);
});

test("document tools reject cross-session references, arbitrary paths, multi-calls and incomplete output", () => {
    expect(parseAgentDocumentTool(call("read_document", { document_id: "brief", section_start: 1 }), [document])).toMatchObject({ kind: "read", figures: [{ id: "brief-f1" }] });
    for (const args of [{ document_id: "foreign" }, { document_id: "brief", path: "C:/private" }, { document_id: "brief", url: "https://outside.invalid" }]) expect(() => parseAgentDocumentTool(call("read_document", args), [document])).toThrow();
    const proposal = call("propose_requirements", confirmedDesignRequirements(card));
    expect(parseAgentDocumentTool(proposal, [document])).toMatchObject({ kind: "requirements", requirements: { avoid: ["口袋"] } });
    expect(() => parseAgentDocumentTool({ ...proposal, toolCalls: [...proposal.toolCalls, ...call("edit_image", { prompt: "run" }).toolCalls] }, [document])).toThrow();
    expect(() => parseAgentDocumentTool({ ...proposal, stopReason: "max_tokens" }, [document])).toThrow();
    expect(() => parseAgentDocumentTool(proposal, [])).toThrow();
    expect(confirmedDesignRequirements({ ...card, status: "draft" })).toBeUndefined();
    expect(confirmedDesignRequirements(card)).not.toHaveProperty("status");
});

test("branch uses the source turn's documents and requirement snapshot, not later changes", () => {
    const later = { ...document, id: "later" };
    const session: ChatSession = { id: "s", title: "s", updatedAt: "now", documents: [document, later], requirementCard: { ...card, subject: "later" }, messages: [
        { id: "first", role: "user", content: "做一版", documentIds: ["brief"], requirementCard: card, createdAt: "now" },
        { id: "second", role: "user", content: "新需求", createdAt: "now" },
    ] };
    const branch = createChatBranch(session, "first", "branch", "now").session;
    expect(branch.documents).toEqual([document]);
    expect(branch.requirementCard).toEqual(card);
    const task = { prompt: "make", modelId: "gpt-image-2", action: "generate" as const, requirements: confirmedDesignRequirements(card) };
    expect(chatImageTaskSignature(task)).not.toBe(chatImageTaskSignature({ ...task, requirements: { ...task.requirements!, avoid: ["条纹"] } }));
});

test("canvas cloud conversion includes original document and figure separately, while retaining requirement data", async () => {
    const calls: string[] = [];
    const source = { chatSessions: [{ documents: [document], requirementCard: card }] };
    const converted = await portableCanvasMedia(source, async input => { calls.push(input.storageKey!); return `/api/assets/${input.storageKey}/content`; });
    expect(calls.sort()).toEqual(["document:original", "image:page"]);
    expect(converted.chatSessions[0].documents[0].source).toMatchObject({ dataUrl: "/api/assets/document:original/content", mimeType: "application/pdf" });
    expect(converted.chatSessions[0].documents[0].source).not.toHaveProperty("storageKey");
    expect(converted.chatSessions[0].requirementCard).toEqual(card);
    expect(source.chatSessions[0].documents[0].source?.storageKey).toBe("document:original");
});

test("cleanup protects original design files retained by local chat sessions", async () => {
    const store = { async iterate<T, U>(visit: (value: T, key: string, index: number) => U) { return visit({ documents: [document] } as T, "wireless-canvas:llm-chat:owner:session:s", 1); } };
    const keys = await collectChatImageReferences(store);
    expect(keys.has("document:original")).toBe(true);
    expect(keys.has("image:page")).toBe(true);
});
