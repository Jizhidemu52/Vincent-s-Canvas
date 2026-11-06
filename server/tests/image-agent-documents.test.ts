import { describe, expect, test } from "bun:test";
import { designRequirementsText, type AgentDocumentCatalogEntry, type DesignRequirements } from "../../shared/image-agent-documents";
import { imageAgentContextSchema, imageAgentProviderPrompt, readImageAgentGenerationProfile } from "../src/image-agent-profile";
import { prepareChatProfileInput, validateChatProfileOutput } from "../src/prompt-chat-profiles";
import type { ChatCompletionResult } from "../src/routes/chat";

const catalog: AgentDocumentCatalogEntry[] = [{ id: "brief", name: "毛衫需求.pdf", kind: "pdf", sectionCount: 6, figureCount: 2,
    sections: Array.from({ length: 6 }, (_, index) => ({ id: `page-${index + 1}`, figureIds: index < 2 ? [`brief:figure-${index + 1}`] : [] })) }];
const otherDocument: AgentDocumentCatalogEntry = { id: "other", name: "另一份.pdf", kind: "pdf", sectionCount: 1, figureCount: 1,
    sections: [{ id: "other:page-1", figureIds: ["other:figure-1"] }] };
const requirements: DesignRequirements = {
    title: "秋冬毛衫", documentIds: ["brief"], subject: "女士落肩开衫", colors: "浅燕麦色",
    materials: "羊毛混纺", must: ['保留印字 "INCHOICE"', "五粒扣"], avoid: ["口袋", "亮片"],
    unknowns: ["袖长尚未提供"], referenceFigureIds: ["brief:figure-1"], sources: [{ documentId: "brief", sectionId: "page-1" }],
};
const context = { stage: "plan" as const, currentUserText: "按文件做一版", imageCatalog: [], previewImageIds: [], workNote: "", documentCatalog: catalog };
const request = (profile: "creative-chat" | "canvas-assistant" = "creative-chat", patch = {}) => ({
    profile, toolKey: profile === "creative-chat" ? "gpt-chat" : "canvas-chat", input: [{ role: "user" as const, content: context.currentUserText }],
    tools: [], profileContext: { ...context, ...patch },
});
const call = (name: string, args: unknown): ChatCompletionResult => ({ content: "", toolCalls: [{ id: "call", type: "function", function: { name, arguments: JSON.stringify(args) } }] });

describe("image-agent document planning boundary", () => {
    test.each(["creative-chat", "canvas-assistant"] as const)("%s offers local document lookup and draft cards only for supplied documents", async profile => {
        for (const stage of ["plan", "continue"]) {
            const prepared = await prepareChatProfileInput(request(profile, { stage }));
            expect(prepared.input.tools.map(tool => tool.name)).toContain("read_document");
            expect(prepared.input.tools.map(tool => tool.name)).toContain("propose_requirements");
            expect(JSON.stringify(prepared.input.tools.find(tool => tool.name === "read_document")!.parameters)).toContain('"brief"');
            expect(validateChatProfileOutput(call("read_document", { document_id: "brief", section_start: 2, section_count: 3 }), prepared.privateRules).toolCalls).toHaveLength(1);
            expect(validateChatProfileOutput(call("propose_requirements", requirements), prepared.privateRules).toolCalls).toHaveLength(1);
        }
        const closed = await prepareChatProfileInput(request(profile, { documentsInspected: true }));
        expect(closed.input.tools.some(tool => tool.name === "read_document")).toBe(false);
        expect(closed.input.tools.some(tool => tool.name === "propose_requirements")).toBe(true);
        const empty = await prepareChatProfileInput(request(profile, { documentCatalog: [] }));
        expect(empty.input.tools.some(tool => ["read_document", "propose_requirements"].includes(tool.name))).toBe(false);
    });

    test("a confirmed requirement snapshot survives independently of history and remains task data", async () => {
        const prepared = await prepareChatProfileInput(request("creative-chat", { requirements }));
        expect((prepared.input.input.at(-2) as { content: string }).content).toContain(JSON.stringify(requirements));
        expect(prepared.input.input.at(-1)).toEqual({ role: "user", content: context.currentUserText });
        expect((prepared.input.input[0] as { content: string }).content).toContain("待用户校对");
        expect((prepared.input.input[0] as { content: string }).content).toContain("不自动确认");
    });

    test.each([
        { documentCatalog: [...catalog, ...catalog] },
        { documentCatalog: Array.from({ length: 9 }, (_, index) => ({ ...catalog[0], id: `doc-${index}` })) },
        { documentCatalog: [{ ...catalog[0], sectionCount: 201 }] },
        { documentCatalog: [{ ...catalog[0], sectionCount: 5 }] },
        { documentCatalog: [{ ...catalog[0], figureCount: 1 }] },
        { documentCatalog: [{ ...catalog[0], sections: undefined }] },
        { documentCatalog: [{ ...catalog[0], sections: [catalog[0]!.sections[0], catalog[0]!.sections[0]], sectionCount: 2 }] },
        { documentCatalog: [{ ...catalog[0], sections: [{ id: "brief", figureIds: ["brief:figure-1", "brief:figure-2"] }], sectionCount: 1 }] },
        { documentCatalog: [{ ...catalog[0], sections: [{ id: "page-1", figureIds: ["brief:figure-1", "brief:figure-1"] }], sectionCount: 1 }] },
        { documentCatalog: [...catalog, { ...otherDocument, sections: [{ id: "other:page-1", figureIds: ["brief:figure-1"] }] }] },
        { documentCatalog: [{ ...catalog[0], id: "https://outside.invalid/brief.pdf" }] },
        { documentCatalog: [{ ...catalog[0], url: "https://outside.invalid/brief.pdf" }] },
        { requirements: { ...requirements, documentIds: ["foreign"] } },
        { requirements: { ...requirements, sources: [{ documentId: "foreign", sectionId: "page-1" }] } },
        { requirements: { ...requirements, sources: [{ documentId: "brief", sectionId: "page-99" }] } },
        { documentCatalog: [...catalog, otherDocument], requirements: { ...requirements, referenceFigureIds: ["other:figure-1"] } },
        { requirements: { ...requirements, referenceFigureIds: ["C:/private.png"] } },
        { requirements: { ...requirements, must: ["   "] } },
        { requirements: { ...requirements, status: "draft" } },
        { requirements: { ...requirements, must: Array(20).fill("字".repeat(400)), avoid: ["另一项"] } },
    ])("invalid document context is rejected before planning", patch => {
        expect(imageAgentContextSchema.safeParse({ ...context, ...patch }).success).toBe(false);
    });

    test("lookup and proposals reject outside document IDs, paths, unbounded sections and parallel generation", async () => {
        const prepared = await prepareChatProfileInput(request());
        for (const args of [
            { document_id: "foreign" }, { document_id: "https://outside.invalid/brief.pdf" },
            { document_id: "brief", path: "C:/private.txt" }, { document_id: "brief", section_start: 0 },
            { document_id: "brief", section_start: 7 },
            { document_id: "brief", section_count: 4 }, { document_id: "brief", query: "x".repeat(1001) },
            { document_id: "brief", query: `needle${" ".repeat(1000)}` },
        ]) expect(() => validateChatProfileOutput(call("read_document", args), prepared.privateRules)).toThrow();
        for (const card of [
            { ...requirements, documentIds: ["foreign"] }, { ...requirements, sources: [{ documentId: "foreign", sectionId: "page-1" }] },
            { ...requirements, sources: [{ documentId: "brief", sectionId: "page-99" }] },
            { ...requirements, referenceFigureIds: ["foreign:figure-1"] },
            { ...requirements, avoid: ["  "] },
            { ...requirements, status: "confirmed" }, { ...requirements, imagePrompt: "generate immediately" },
        ]) expect(() => validateChatProfileOutput(call("propose_requirements", card), prepared.privateRules)).toThrow();
        for (const name of ["read_document", "propose_requirements"]) {
            const first = call(name, name === "read_document" ? { document_id: "brief" } : requirements);
            expect(() => validateChatProfileOutput({ ...first, toolCalls: [...first.toolCalls, ...call("edit_image", { prompt: "立即出图" }).toolCalls] }, prepared.privateRules)).toThrow();
        }
    });

    test("proposals bind every section and figure to their selected document, not merely the session", async () => {
        const prepared = await prepareChatProfileInput(request("canvas-assistant", { documentCatalog: [...catalog, otherDocument] }));
        for (const card of [
            { ...requirements, referenceFigureIds: ["other:figure-1"] },
            { ...requirements, sources: [{ documentId: "brief", sectionId: "other:page-1" }] },
        ]) expect(() => validateChatProfileOutput(call("propose_requirements", card), prepared.privateRules)).toThrow();
        expect(validateChatProfileOutput(call("propose_requirements", { ...requirements, documentIds: ["brief", "other"], referenceFigureIds: ["other:figure-1"], sources: [{ documentId: "other", sectionId: "other:page-1" }] }), prepared.privateRules).toolCalls).toHaveLength(1);
    });

    test("validated manifests stay request-local and cannot be changed through the original client context", async () => {
        const supplied = structuredClone(catalog);
        const first = await prepareChatProfileInput(request("creative-chat", { documentCatalog: supplied }));
        supplied[0]!.sections[0]!.figureIds = ["forged:figure"];
        const second = await prepareChatProfileInput(request("creative-chat", { documentCatalog: supplied }));
        expect(validateChatProfileOutput(call("propose_requirements", requirements), first.privateRules).toolCalls).toHaveLength(1);
        expect(() => validateChatProfileOutput(call("propose_requirements", requirements), second.privateRules)).toThrow();
        expect(() => validateChatProfileOutput(call("propose_requirements", { ...requirements, referenceFigureIds: ["forged:figure"] }), first.privateRules)).toThrow();
    });

    test("document metadata cannot bypass the existing five-preview or 60000-character context limits", async () => {
        const large = request("canvas-assistant", { settings: { untrusted: "x".repeat(60_000) } });
        await expect(prepareChatProfileInput(large)).rejects.toMatchObject({ code: "CHAT_PROFILE_INVALID" });
        const previews = { role: "user" as const, content: Array.from({ length: 6 }, () => ({ type: "input_image" as const, image_url: "data:image/png;base64,AA==" })) };
        await expect(prepareChatProfileInput({ ...request(), input: [previews, ...request().input] })).rejects.toMatchObject({ code: "CHAT_PROFILE_INVALID" });
    });
});

describe("image-agent confirmed requirements at provider submission", () => {
    test("compiles known visual facts before current instructions, without unknowns or public archive mutation", async () => {
        const input = { prompt: "本轮只改成黑色", operationType: "inpaint", parameters: { imageAgentProfile: "creative-chat", designRequirements: requirements, designDocumentCatalog: catalog, inputArchive: { prompt: "本轮只改成黑色" } } };
        const before = JSON.stringify(input);
        const prompt = await imageAgentProviderPrompt(input, async () => "PRIVATE_IMAGE_RECIPE");
        expect(prompt).toContain(designRequirementsText(requirements));
        expect(prompt).not.toContain(requirements.unknowns[0]!);
        expect(prompt).not.toContain("brief:figure-1");
        expect(prompt.endsWith(input.prompt)).toBe(true);
        expect(prompt.indexOf(designRequirementsText(requirements))).toBeLessThan(prompt.lastIndexOf(input.prompt));
        expect(JSON.stringify(input)).toBe(before);
    });

    test("rejects non-agent, unconfirmed card objects and oversized snapshots before loading a recipe", async () => {
        let loads = 0;
        const load = async () => { loads++; return "PRIVATE_IMAGE_RECIPE"; };
        const base = { prompt: "生成毛衫", operationType: "image_generation" };
        for (const parameters of [
            { designRequirements: requirements },
            { designDocumentCatalog: catalog },
            { imageAgentProfile: "creative-chat", designRequirements: requirements },
            { imageAgentProfile: "creative-chat", designDocumentCatalog: catalog },
            { imageAgentProfile: "creative-chat", designRequirements: requirements, designDocumentCatalog: [] },
            { imageAgentProfile: "creative-chat", designRequirements: requirements, designDocumentCatalog: [{ ...catalog[0], figureCount: 3 }] },
            { imageAgentProfile: "creative-chat", designRequirements: { ...requirements, sources: [{ documentId: "brief", sectionId: "page-99" }] }, designDocumentCatalog: catalog },
            { imageAgentProfile: "creative-chat", designRequirements: { ...requirements, referenceFigureIds: ["other:figure-1"] }, designDocumentCatalog: [...catalog, otherDocument] },
            { imageAgentProfile: "creative-chat", designRequirements: { ...requirements, status: "draft", id: "card", updatedAt: "now" }, designDocumentCatalog: catalog },
            { imageAgentProfile: "creative-chat", designRequirements: { ...requirements, must: Array(20).fill("字".repeat(400)) }, designDocumentCatalog: catalog },
        ]) {
            expect(() => readImageAgentGenerationProfile(parameters, base.operationType)).toThrow();
            await expect(imageAgentProviderPrompt({ ...base, parameters }, load)).rejects.toThrow();
        }
        expect(loads).toBe(0);
    });
});
