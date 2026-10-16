import { expect, test } from "bun:test";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { moveImageReference } from "@/lib/image-reference-policy";
import type { ReferenceImage } from "@/types/image";

const reference = (id: string, name: string): ReferenceImage => ({ id, name, type: "image/png", dataUrl: `data:image/png;base64,${id}`, storageKey: `image:${id}` });
const original = [reference("SOURCE", "原图"), reference("PALETTE", "颜色参考"), reference("PATTERN", "图案参考")];

test("English numbering follows the supplied reordered references without changing their order", () => {
    const reordered = moveImageReference(original, 2, 0);
    const before = JSON.stringify(reordered);
    const prompt = "Use Image 1 as the pattern reference, Image 2 as the product base, and Image 3 for colors only.";
    const text = buildImageReferencePromptText(prompt, reordered, "en");
    expect(reordered.map(image => image.id)).toEqual(["PATTERN", "SOURCE", "PALETTE"]);
    expect(text).toBe(`Reference images in the supplied order: Image 1, Image 2, Image 3. Interpret all image references using these numbers.\n\n${prompt}`);
    expect(text).not.toMatch(/[\u3400-\u9fff]/u);
    expect(JSON.stringify(reordered)).toBe(before);
    expect(original.map(image => image.id)).toEqual(["SOURCE", "PALETTE", "PATTERN"]);
    expect(buildImageReferencePromptText("Use Image 1 as the base.", reordered.slice(1), "en").split("\n")[0]).toBe("Reference images in the supplied order: Image 1, Image 2. Interpret all image references using these numbers.");
});

test("English reference instructions preserve literal Chinese artwork text verbatim", () => {
    const prompt = 'Keep the product from Image 1 unchanged and retain the exact logo text "春日快乐".';
    const text = buildImageReferencePromptText(`  ${prompt}  `, [original[0]!], "en");
    expect(text).toBe(`Reference images in the supplied order: Image 1. Interpret all image references using these numbers.\n\n${prompt}`);
    expect(text).toContain('text "春日快乐"');
    expect(text.replace("春日快乐", "")).not.toMatch(/[\u3400-\u9fff]/u);
    expect(text).not.toContain("原图");
});

test("default language retains the existing Chinese reference prefix and prompt", () => {
    const prompt = "保留图片1的产品结构，采用图片2的颜色。";
    const refs = original.slice(0, 2);
    const expected = `参考图片编号：图片1、图片2。请按这些编号理解提示词中的图片引用。\n\n${prompt}`;
    expect(buildImageReferencePromptText(`\n ${prompt} \n`, refs)).toBe(expected);
    expect(buildImageReferencePromptText(prompt, refs, "zh")).toBe(expected);
});

test("no references leaves only the trimmed prompt in either language", () => {
    expect(buildImageReferencePromptText("  Keep the product unchanged.\n", [], "en")).toBe("Keep the product unchanged.");
    expect(buildImageReferencePromptText("\n保留产品。  ", [])).toBe("保留产品。");
    expect(buildImageReferencePromptText("  ", [], "en")).toBe("");
    expect(buildImageReferencePromptText("", [], "zh")).toBe("");
});
