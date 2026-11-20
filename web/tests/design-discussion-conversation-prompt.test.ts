import { describe, expect, test } from "bun:test";
import { compileConversationImagePrompt } from "../../shared/image-agent/conversation";
import type { EditPlan, ImageVersion } from "../../shared/image-conversation-contracts";
import { buildDesignConversationText, type DesignConversationInput, type DesignReferenceAsset } from "../src/components/canvas/design-discussion/conversation-execution";
import { conversationIds, conversationVersion } from "./fixtures/image-conversation";

const asset: DesignReferenceAsset = { id: "image-1700000000100-source", assetId: conversationIds.asset,
    title: "SUN-6-buttons.webp", image: `/api/assets/${conversationIds.asset}/content`, role: "base" };
const evidence = (originalText: string, effectiveText = originalText) => ({ originalText, effectiveText,
    referenceSnapshot: [{ id: asset.id, title: asset.title, role: "base", label: "图1" }] });
const execution = (requirementEvidence = [evidence("只用文字比较两者的休闲感，不出图。", "只用文字比较两者的休闲感，")]): DesignConversationInput => ({
    generationAllowed: true, mediaKind: "image", references: [asset],
    userText: requirementEvidence.map(item => item.effectiveText).join("\n"), prompt: "将全衣统一改成烟粉棕，保留圆领、袖长和针织纹理。",
    proposal: { id: "rose:output", batchId: "batch-fixture", title: "烟粉棕毛衣", requirementEvidence },
});

function compile(text: string, instruction = "将全衣统一改成烟粉棕，保留圆领、袖长和针织纹理。") {
    const base: ImageVersion = { ...conversationVersion(), label: "图1", parameters: null };
    const plan: EditPlan = { action: "edit", assistantText: "按所选方案修改", base: { kind: "current" }, stateSource: "base",
        changes: [{ kind: "set", target: "衣服", instruction }], preserve: [], revoke: [], references: [],
        outputIntent: { purpose: "standard", complexity: "low" } };
    return compileConversationImagePrompt({ plan, versions: [base], base, sourceState: base.requestedState,
        sourceStateVersion: base, turnId: conversationIds.turn, userText: text });
}

describe("design discussion text consumed by the persisted image-plan compiler", () => {
    test("history ending in a comparison comma does not promote snapshot keys, filenames or asset numbers into artwork", () => {
        const first = evidence("只用文字比较两者的休闲感，不出图。", "只用文字比较两者的休闲感，");
        const latest = evidence("全衣统一改成烟粉棕，先保留圆领、袖长和针织纹理。", "全衣统一改成烟粉棕，保留圆领、袖长和针织纹理。");
        const input = execution([first, latest]);
        const text = buildDesignConversationText(input, [asset]);
        expect(compile(text).prompt).toContain("全衣统一改成烟粉棕");
        for (const field of ["sourceId", "assetId", "referenceSnapshot", asset.id, asset.assetId, asset.title]) expect(text).not.toContain(field);
        for (const item of [first, latest]) {
            expect(text).toContain(item.originalText);
            expect(text).toContain(item.effectiveText);
        }
        expect(text.indexOf(first.originalText)).toBeLessThan(text.indexOf(latest.originalText));
        expect(input.proposal.requirementEvidence).toEqual([first, latest]);
        expect(input.references[0]).toMatchObject(asset);
    });

    test.each(["userText", "originalText", "effectiveText"] as const)("an explicit button count in %s is still enforced even when a filename also contains it", field => {
        const input = execution([evidence("保留原来的针织纹理。")]);
        if (field === "userText") input.userText = "保留6颗纽扣和针织纹理。";
        else (input.proposal.requirementEvidence![0] as ReturnType<typeof evidence>)[field] = "保留6颗纽扣和针织纹理。";
        const text = buildDesignConversationText(input, [asset]);
        expect(() => compile(text)).toThrow("遗漏可确定的数量");
        expect(compile(text, "将全衣改成烟粉棕，保留6颗纽扣和针织纹理。").prompt).toContain("6颗纽扣");
    });

    test.each(["userText", "originalText", "effectiveText"] as const)("explicit artwork wording in %s is still enforced even when a filename also contains it", field => {
        const input = execution([evidence("保留原来的针织纹理。")]);
        if (field === "userText") input.userText = "保留文字“SUN”和针织纹理。";
        else (input.proposal.requirementEvidence![0] as ReturnType<typeof evidence>)[field] = "保留文字“SUN”和针织纹理。";
        const text = buildDesignConversationText(input, [asset]);
        expect(() => compile(text)).toThrow("遗漏必须保留的文字标识");
        expect(compile(text, "将全衣改成烟粉棕，保留文字“SUN”和针织纹理。").prompt).toContain("SUN");
    });

    test("historical image order maps by identity while current roles and removed references stay explicit", () => {
        const second = { ...asset, id: "image-1700000000200-color", assetId: conversationIds.resultAsset,
            image: `/api/assets/${conversationIds.resultAsset}/content`, title: "color-18.webp", role: "style" };
        const originalText = "保留图2的款式，参考图1的配色。";
        const effectiveText = "保留图1的款式，参考图2的配色。";
        const input = { ...execution(), references: [asset, second], userText: effectiveText };
        input.proposal.requirementEvidence = [{ originalText, effectiveText, referenceSnapshot: [
            { id: second.id, title: second.title, role: "color", label: "图1" },
            { id: asset.id, title: asset.title, role: "base", label: "图2" },
            { id: "image-1700000000300-removed", title: "old-42.webp", role: "reference", label: "图3" },
        ] }];
        const text = buildDesignConversationText(input, [asset, second]);
        expect(text).toContain(originalText);
        expect(text).toContain(effectiveText);
        expect(text).toContain("历史图1（当时用途：只参考颜色）对应本轮图2（本轮用途：风格参考）");
        expect(text).toContain("历史图2（当时用途：修改对象）对应本轮图1（本轮用途：修改对象）");
        expect(text).toContain("历史图3（当时用途：辅助参考）未选入本轮");
        expect(text).toContain("图1：修改对象");
        expect(text).toContain("图2：风格参考");
        expect(compile(text).prompt).toContain("全衣统一改成烟粉棕");
    });
});
