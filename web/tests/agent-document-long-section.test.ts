import { expect, test } from "bun:test";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { prepareChatProfileInput, validateChatProfileOutput } from "../../server/src/prompt-chat-profiles";
import { agentDocumentCatalog, agentDocumentContext, readAgentDocument } from "../src/lib/agent-documents";
import { parseChatAttachment } from "../src/lib/chat-attachments";
import { wordDocumentFixture } from "./fixtures/agent-document-fixtures";
import type { AgentDocument, AgentDocumentReadInput } from "../../shared/image-agent-documents";

async function longWord() {
    const archive = unzipSync(wordDocumentFixture().original);
    archive["word/document.xml"] = strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + "前文内容".repeat(10_000) + "TAIL_SPEC：禁止皮草" + '</w:t></w:r></w:p></w:body></w:document>');
    return (await parseChatAttachment(new File([zipSync(archive)], "长单段.docx"))).document!;
}

async function validateRead(document: AgentDocument, args: AgentDocumentReadInput) {
    const prepared = await prepareChatProfileInput({ profile: "creative-chat", toolKey: "gpt-chat", tools: [],
        input: [{ role: "user", content: "查阅设计文件" }],
        profileContext: { stage: "plan", currentUserText: "查阅设计文件", imageCatalog: [], previewImageIds: [], workNote: "", documentCatalog: agentDocumentCatalog([document]) },
    });
    validateChatProfileOutput({ content: "", toolCalls: [{ id: "read", type: "function", function: { name: "read_document", arguments: JSON.stringify(args) } }] }, prepared.privateRules);
}

test("a keyword lookup of a 40k Word paragraph returns the actual tail match, not another prefix", async () => {
    const document = await longWord();
    const before = JSON.stringify(document);
    expect(document.sections).toHaveLength(1);
    expect(agentDocumentContext([document])).not.toContain("TAIL_SPEC");
    const input = { document_id: document.id, query: "TAIL_SPEC", section_count: 1 };
    await validateRead(document, input);
    const read = readAgentDocument([document], input);
    expect(read.text.includes("TAIL_SPEC：禁止皮草")).toBe(true);
    expect(read.text).toContain("前文未展示");
    expect(read.text.length).toBeLessThanOrEqual(18_000);
    expect(read.chunks[0]).toMatchObject({ sectionId: document.sections[0]!.id, sectionNumber: 1 });
    expect(read.chunks[0]!.characterStart).toBeGreaterThan(30_000);
    expect(JSON.stringify(document)).toBe(before);
});

test("one-based character cursors can read every character of a long stored section exactly once", async () => {
    const document = await longWord();
    const chunks: string[] = [];
    let cursor: AgentDocumentReadInput | undefined = { document_id: document.id, section_start: 1, section_count: 1 };
    let nextCharacter = 1;
    for (let iteration = 0; cursor && iteration < 10; iteration++) {
        await validateRead(document, cursor);
        const read = readAgentDocument([document], cursor);
        expect(read.text.length).toBeLessThanOrEqual(18_000);
        expect(read.chunks).toHaveLength(1);
        expect(read.chunks[0]!.characterStart).toBe(nextCharacter);
        chunks.push(read.chunks[0]!.text);
        nextCharacter = read.chunks[0]!.characterEnd + 1;
        cursor = read.continuations[0];
        if (cursor) {
            expect(cursor).toMatchObject({ document_id: document.id, section_start: 1, section_count: 1, character_start: nextCharacter });
            expect(read.text).toContain(JSON.stringify(cursor));
        }
    }
    expect(cursor).toBeUndefined();
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.join("")).toBe(document.sections[0]!.text);
});

test("character cursors reject ambiguous multi-section or keyword requests at both boundaries", async () => {
    const document = await longWord();
    for (const patch of [
        { character_start: 0 }, { character_start: 1.5 }, { character_start: 1_000_001 },
        { character_start: 10, section_count: 2 }, { character_start: 10, query: "TAIL_SPEC" },
    ]) {
        const input = { document_id: document.id, ...patch };
        await expect(validateRead(document, input)).rejects.toThrow();
        expect(() => readAgentDocument([document], input)).toThrow();
    }
    expect(() => readAgentDocument([document], { document_id: document.id, character_start: 90_000 })).toThrow();
});

test("partial text ranges retain the real section-to-figure binding and expose later sections", async () => {
    const document = await longWord();
    document.figures = [{ id: "long:figure", sectionId: document.sections[0]!.id, name: "参考.png", label: "参考", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" }];
    document.sections[0]!.figureIds.push("long:figure");
    document.sections.push({ id: "long:second", title: "另一节", text: "纽扣必须五粒", figureIds: [] });
    const read = readAgentDocument([document], { document_id: document.id, section_count: 1, character_start: 40_001 });
    expect(read.figures[0]).toBe(document.figures[0]);
    expect(read.text).toContain(document.sections[0]!.id);
    expect(read.text).toContain("long:figure");
    expect(read.continuations).toContainEqual({ document_id: document.id, section_start: 2, section_count: 1 });
    const second = readAgentDocument([document], read.continuations.find(input => input.section_start === 2));
    expect(second.text).toContain("纽扣必须五粒");
});

test("literal keyword matching does not treat requirement punctuation as a regular expression", async () => {
    const document = await longWord();
    document.sections[0]!.text = "前文".repeat(20_000) + "C++ [保持原样]";
    const read = readAgentDocument([document], { document_id: document.id, query: "c++ [保持原样]" });
    expect(read.text.includes("C++ [保持原样]")).toBe(true);
});

test("maximal legal IDs and figure manifests leave room for bounded text and complete cursors", () => {
    const document: AgentDocument = { id: "d".repeat(300), name: "n".repeat(200), kind: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: 1, warnings: [], figures: [],
        sections: Array.from({ length: 3 }, (_, index) => ({ id: `s${index}`.padEnd(300, "s"), title: "标题".repeat(1000), text: "正文".repeat(10_000), figureIds: [] })) };
    for (let index = 0; index < 80; index++) {
        const section = document.sections[index % 3]!;
        const id = `f${index}`.padEnd(300, "f");
        section.figureIds.push(id);
        document.figures.push({ id, sectionId: section.id, name: "图.png", label: "图", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" });
    }
    const read = readAgentDocument([document], { document_id: document.id });
    expect(read.text.length).toBeLessThanOrEqual(18_000);
    expect(read.chunks).toHaveLength(3);
    expect(read.continuations).toHaveLength(3);
    for (const continuation of read.continuations) expect(read.text.includes(JSON.stringify(continuation))).toBe(true);
    expect(read.figures).toHaveLength(3);
});
