import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { GarmentBrief } from "@/lib/garment-recipe";
import { GarmentRecipePanel, garmentDraftChanged } from "@/pages/creative/garment-recipe-panel";
import type { ImageReferenceItem } from "@/types/image";

const reference: ImageReferenceItem = {
    id: "garment-original-id",
    referenceKey: "garment-reference-key",
    name: "服装原图.png",
    type: "image/png",
    dataUrl: "data:image/png;base64,original-image-content",
    origin: "upload",
    originLabel: "上传",
};
const brief: GarmentBrief = { scenario: "colorway", primaryId: reference.id, target: "衣身改成雾蓝色", preserve: "保留袖口滚边" };

function panel(props: Partial<Parameters<typeof GarmentRecipePanel>[0]> = {}) {
    return renderToStaticMarkup(<GarmentRecipePanel references={[]} disabled={false} onApply={() => { throw new Error("Rendering must not apply a recipe"); }} onDraftChange={() => { throw new Error("Rendering must not dirty a draft"); }} {...props} />);
}

function actionButton(markup: string, label: string) {
    const button = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(item => item.includes(label));
    if (!button) throw new Error(`Missing action button: ${label}`);
    return button;
}

describe("compact garment panel", () => {
    test("defaults to a collapsed text shortcut without a second prompt editor or model controls", () => {
        const markup = panel();
        expect(actionButton(markup, "服装 · 换色 / 改款")).toContain('aria-expanded="false"');
        expect(markup.match(/<textarea\b/g)).toHaveLength(1);
        expect(markup).not.toContain("出图指令预览");
        expect(markup).not.toContain("LLM");
        expect(markup).not.toContain("花型");
        expect(markup).not.toContain("上身");
        expect(markup).toContain("仅回填，不会出图");
    });

    test("an independent scenario shows its labeled form without duplicate navigation or scene switching", () => {
        for (const [initialScenario, targetLabel] of [["restyle", "改款目标"], ["colorway", "目标配色与部位"]] as const) {
            const markup = panel({ initialScenario });
            expect(markup).not.toContain("服装 · 换色 / 改款");
            expect(markup).not.toContain('type="radio"');
            expect(markup).toContain(`>${targetLabel}</label>`);
            expect(markup).toContain(`aria-label="${targetLabel}"`);
            expect(markup).toContain('rows="2"');
            // Only the optional preservation field is hidden, not the scene form.
            expect(markup.match(/hidden=""/g)).toHaveLength(1);
            expect(actionButton(markup, "套用到提示词")).toContain('disabled=""');
        }
    });

    test("single-image input binds the garment without adding a redundant dropdown", () => {
        const markup = panel({ references: [reference], initialScenario: "colorway" });
        expect(markup).toContain("服装图：");
        expect(markup).toContain("服装原图.png");
        expect(markup).not.toContain("ant-select");
        expect(actionButton(markup, "保留要求（可选）")).toContain('aria-expanded="false"');
    });

    test("multiple images require an explicit stable garment selection", () => {
        const markup = panel({ references: [reference, { ...reference, id: "second", referenceKey: "second", name: "另一张.png" }] });
        expect(markup).toContain("ant-select");
        expect(markup).toContain('aria-label="服装主图"');
        expect(markup).toContain("选择服装主图（仅此图会用于生成）");
        expect(actionButton(markup, "套用到提示词")).toContain('disabled=""');
    });

    test("a generation in progress disables the compact form", () => {
        const markup = panel({ references: [reference], disabled: true, initialScenario: "colorway" });
        const buttons = markup.match(/<button\b[^>]*>/g) || [];
        const inputs = markup.match(/<(?:input|textarea)\b[^>]*>/g) || [];
        expect(buttons).toHaveLength(2);
        expect(buttons.every(button => button.includes('disabled=""'))).toBe(true);
        expect(inputs).toHaveLength(2);
        expect(inputs.every(input => input.includes('disabled=""'))).toBe(true);
    });
});

describe("meaningful garment draft changes", () => {
    test("an empty shortcut and a scene change without a target do not block ordinary prompts", () => {
        expect(garmentDraftChanged({ ...brief, target: "", preserve: "" }, null)).toBe(false);
        expect(garmentDraftChanged({ ...brief, scenario: "restyle", target: "  " }, null)).toBe(false);
        expect(garmentDraftChanged(brief, null)).toBe(true);
    });

    test("the just-applied draft and semantically equal whitespace changes are clean", () => {
        expect(garmentDraftChanged({ ...brief }, brief)).toBe(false);
        expect(garmentDraftChanged({ ...brief, target: `  ${brief.target}\n`, preserve: `${brief.preserve}  ` }, brief)).toBe(false);
    });

    test("changing any applied field, including clearing the target, requires another apply", () => {
        for (const patch of [{ scenario: "restyle" as const }, { primaryId: "new-garment" }, { target: "改为红色" }, { target: "" }, { preserve: "保留原领口" }]) {
            expect(garmentDraftChanged({ ...brief, ...patch }, brief)).toBe(true);
        }
    });

    test("returning an edited draft to the applied fields removes the draft-only block", () => {
        const changed = { ...brief, target: "改为红色" };
        expect(garmentDraftChanged(changed, brief)).toBe(true);
        expect(garmentDraftChanged({ ...changed, target: brief.target }, brief)).toBe(false);
    });
});
