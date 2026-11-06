import { describe, expect, it } from "bun:test";
import { agentDocumentCatalog, agentDocumentContext, parseDesignRequirements, readAgentDocument } from "../src/lib/agent-documents";
import type { AgentDocument, DesignRequirements } from "../../shared/image-agent-documents";

const document = (id = "doc-1"): AgentDocument => ({ id, name: `${id}.pdf`, kind: "pdf", mimeType: "application/pdf", bytes: 12,
    sections: [{ id: `${id}:s:1`, title: "第一页", text: "燕麦色毛衫，不要口袋", figureIds: [`${id}:f:1`] }, { id: `${id}:s:2`, title: "第二页", text: "尺寸表，袖长待确认", figureIds: [] }],
    figures: [{ id: `${id}:f:1`, sectionId: `${id}:s:1`, name: "第一页.png", label: "文件图1", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" }], warnings: [] });
const requirements = (): DesignRequirements => ({ title: "毛衫需求", documentIds: ["doc-1"], subject: "女士毛衫", colors: "燕麦色", materials: "针织",
    must: ["保留罗纹"], avoid: ["口袋"], unknowns: ["袖长"], referenceFigureIds: ["doc-1:f:1"], sources: [{ documentId: "doc-1", sectionId: "doc-1:s:1" }] });

describe("employee session design documents", () => {
    it("uses a manifest without serializing original bytes or preview payloads", () => {
        const catalog = agentDocumentCatalog([document()]);
        expect(catalog[0]?.sections[0]?.figureIds).toEqual(["doc-1:f:1"]);
        expect(JSON.stringify(catalog)).not.toContain("base64");
    });
    it("rejects duplicate IDs, foreign section figures and oversized collections", () => {
        expect(() => agentDocumentCatalog([document(), document()])).toThrow("重复");
        const broken = document(); broken.figures[0]!.sectionId = "foreign";
        expect(() => agentDocumentCatalog([broken])).toThrow("不匹配");
        expect(() => agentDocumentCatalog(Array.from({ length: 9 }, (_, i) => document(`doc-${i}`)))).toThrow("数量");
    });
    it("keeps every file visible within the context budget and labels excerpts", () => {
        const documents = Array.from({ length: 8 }, (_, i) => { const doc = document(`doc-${i}`); doc.sections[0]!.text = "材质".repeat(30_000); return doc; });
        const text = agentDocumentContext(documents);
        expect(text.length).toBeLessThanOrEqual(30_000);
        for (const doc of documents) expect(text).toContain(doc.name);
        expect(text).toContain("仅为文件节选");
        expect(documents[7]!.sections[0]!.text.length).toBe(60_000);
    });
    it("reads named sections and searches text without opening external paths", () => {
        expect(readAgentDocument([document()], { document_id: "doc-1", section_start: 1, section_count: 1 }).figures[0]?.id).toBe("doc-1:f:1");
        expect(readAgentDocument([document()], { document_id: "doc-1", query: "袖长" }).text).toContain("第二页");
        expect(() => readAgentDocument([document()], { document_id: "https://other.test/a" })).toThrow("本会话");
        expect(() => readAgentDocument([document()], { document_id: "doc-1", path: "/etc/passwd" } as never)).toThrow("参数");
        expect(() => readAgentDocument([document()], { document_id: "doc-1", section_count: 4 })).toThrow("范围");
    });
    it("caps lookup text and figures while retaining the stored document", () => {
        const doc = document(); doc.sections[0]!.text = "a".repeat(50_000);
        expect(readAgentDocument([doc], { document_id: doc.id }).text.length).toBeLessThanOrEqual(18_000);
        expect(doc.sections[0]!.text.length).toBe(50_000);
    });
    it("validates requirement sources and figure ownership against the current documents", () => {
        expect(parseDesignRequirements(requirements(), [document()])).toEqual(requirements());
        expect(() => parseDesignRequirements({ ...requirements(), referenceFigureIds: ["other:f:1"] }, [document()])).toThrow("未提供");
        expect(() => parseDesignRequirements({ ...requirements(), sources: [{ documentId: "doc-1", sectionId: "other:s:1" }] }, [document()])).toThrow("来源");
        expect(() => parseDesignRequirements(requirements(), [document("other")])).toThrow("以外");
    });
    it("does not allow tools to confirm cards or silently discard extra instructions", () => {
        expect(() => parseDesignRequirements({ ...requirements(), status: "confirmed" }, [document()])).toThrow("字段");
        expect(() => parseDesignRequirements({ ...requirements(), run: "script" }, [document()])).toThrow("字段");
        expect(() => parseDesignRequirements({ ...requirements(), must: ["x".repeat(401)] }, [document()])).toThrow("列表");
        expect(() => parseDesignRequirements({ ...requirements(), avoid: Array(20).fill("x".repeat(400)) }, [document()])).toThrow("8000");
    });
});
