import { describe, expect, test } from "bun:test";
import { createProposalExecution } from "../src/components/canvas/design-discussion/proposal-execution.mjs";

const reference = { id: "garment", title: "修改对象", image: "/garment.png", role: "base" };
const referenceSnapshot = [{ id: reference.id, title: reference.title, role: reference.role, label: "图1" }];
const proposal = {
    id: "p1", title: "原材质六颗纽扣", features: ["六颗纽扣", "保留原有材质"],
    rationale: "按用户明确要求修改纽扣数量。", prompt: "将图一纽扣改成6颗，保持原有材质。",
    referenceIds: [reference.id], sourceNotes: [],
};
const input = (text: string) => ({
    proposal, references: [reference], userRequirements: [{ text, referenceSnapshot }],
    generationAllowed: true, serverImageExecution: true,
});

describe("selected proposal superseded discussion timing", () => {
    test.each(["也不要生成", "也不生成图片", "这一步只给方案", "这一步只给方案，也不要生成"])("explicit selection supersedes standalone timing: %s", timing => {
        const text = `保持6颗纽扣和原有材质。${timing}。`;
        const result = createProposalExecution(input(text));
        expect(result.userText).toBe("保持6颗纽扣和原有材质。");
        expect(result.executionContract.quantities[0].expected).toBe(6);
        expect(result.proposal.requirementEvidence[0].originalText).toBe(text);
        expect(() => createProposalExecution({ ...input(text), generationAllowed: false })).toThrow("明确点击");
    });

    test.each(["也不要生成口袋", "也不要生成这个版本", "这一步只给方案中的口袋保留原样，也不要生成这个版本"])("does not strip an object-specific prohibition: %s", prohibition => {
        expect(() => createProposalExecution(input(`保持6颗纽扣和原有材质。${prohibition}。`))).toThrow("不出图");
    });

    test.each(["也不要生成", "这一步只给方案"])("timing alone cannot replace independent design requirements: %s", timing => {
        expect(() => createProposalExecution(input(timing))).toThrow("缺少独立");
    });

    test("keeps artwork literals intact when stripping adjacent standalone timing", () => {
        const literal = "也不要生成；这一步只给方案";
        const text = `这一步只给方案。将图一标语改为“${literal}”，保持原有材质。也不要生成。`;
        const result = createProposalExecution({
            ...input(text), proposal: { ...proposal, prompt: `将图一标语改为“${literal}”，保持原有材质。` },
        });
        expect(result.userText).toBe(`将图1标语改为“${literal}”，保持原有材质。`);
        expect(result.prompt).toContain(`“${literal}”`);
        expect(result.proposal.requirementEvidence[0].originalText).toBe(text);
    });
});
