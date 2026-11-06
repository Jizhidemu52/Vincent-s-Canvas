import { expect, test } from "bun:test";
import { imageAgentGenerationParameters } from "../src/lib/image-agent-generation-parameters";
import type { DesignRequirements } from "../../shared/image-agent-documents";

const requirements: DesignRequirements = { title: "毛衫", documentIds: ["doc"], subject: "羊毛开衫", colors: "燕麦", materials: "羊毛", must: ["罗纹"], avoid: ["口袋"], unknowns: ["袖长"], referenceFigureIds: [], sources: [{ documentId: "doc", sectionId: "s1" }] };
const catalog = [{ id: "doc", name: "brief.pdf", kind: "pdf" as const, sectionCount: 1, figureCount: 0, sections: [{ id: "s1", figureIds: [] }] }];

test("ordinary images and agents without documents retain their original payload", () => {
    expect(imageAgentGenerationParameters()).toEqual({});
    expect(imageAgentGenerationParameters({ imageAgentProfile: "creative-chat" })).toEqual({ imageAgentProfile: "creative-chat" });
});
test("both image agent entry points snapshot requirements and manifest without later mutation", () => {
    for (const imageAgentProfile of ["creative-chat", "canvas-assistant"] as const) {
        const input = structuredClone(requirements), documents = structuredClone(catalog);
        const parameters = imageAgentGenerationParameters({ imageAgentProfile, imageAgentRequirements: input, imageAgentDocumentCatalog: documents });
        input.must.push("new"); documents[0]!.sections[0]!.id = "changed";
        expect(parameters.designRequirements).toEqual(requirements);
        expect(parameters.designDocumentCatalog).toEqual(catalog);
    }
});
test("partial document snapshots or non-agent use cannot reach task submission", () => {
    expect(() => imageAgentGenerationParameters({ imageAgentRequirements: requirements, imageAgentDocumentCatalog: catalog })).toThrow("必须一起");
    expect(() => imageAgentGenerationParameters({ imageAgentProfile: "creative-chat", imageAgentRequirements: requirements })).toThrow("必须一起");
    expect(() => imageAgentGenerationParameters({ imageAgentProfile: "canvas-assistant", imageAgentDocumentCatalog: catalog })).toThrow("必须一起");
});
