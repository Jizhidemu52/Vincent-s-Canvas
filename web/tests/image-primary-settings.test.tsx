import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { imagePrimaryControls, ImagePrimarySettings } from "@/components/image-settings-panel";
import { imageModelProfile } from "@/lib/image-model-settings";
import { defaultConfig } from "@/stores/use-config-store";

test("independent resolution controls do not replace quality or normalize saved data on mount", () => {
    const config = { ...defaultConfig, model: "gpt-image-2.6-flare", size: "16:9", quality: "high", imageOptions: '{"resolution":"2k","background":"transparent"}' };
    const before = JSON.stringify(config);
    const profile = imageModelProfile(config.model, []);
    expect(imagePrimaryControls(config, profile)).toMatchObject({ size: "16:9", detailKey: "imageOptions", detailLabel: "分辨率", detailValue: "2k", detailDisabled: false });
    let writes = 0;
    const html = renderToStaticMarkup(<ImagePrimarySettings config={config} profile={profile} modelControl={<button>Model</button>} onConfigChange={() => { writes++; }} />);
    expect(html).toContain('aria-label="常用参数"');
    expect(html).toContain('aria-label="宽高比"');
    expect(html).not.toContain("自定义宽度");
    expect(writes).toBe(0);
    expect(JSON.stringify(config)).toBe(before);
});

test("exact pixel preference disables only independent resolution and preserves both values", () => {
    const config = { ...defaultConfig, model: "gpt-image-2.6-flare", size: "1536x1024", quality: "high", imageOptions: '{"resolution":"4k"}' };
    expect(imagePrimaryControls(config, imageModelProfile(config.model, []))).toMatchObject({ size: "1536x1024", sizeDisabled: false, exactPixels: true, detailValue: "4k", detailDisabled: true });
});

test("Gemini and pixel adapters use quality for their actual resolution parameter", () => {
    for (const model of ["gemini-3.1-flash-image-preview", "vcen-gpt2"]) {
        const primary = imagePrimaryControls({ ...defaultConfig, model, size: "16:9", quality: "2k" }, imageModelProfile(model, []));
        expect(primary).toMatchObject({ detailKey: "quality", detailLabel: "分辨率", detailValue: "2k", detailDisabled: false });
        expect(primary.detailChoices).toContain("4k");
    }
});

test("standard and MJ do not invent independent resolution controls", () => {
    for (const [model, label] of [["gpt-image-2", "画质"], ["midjourney-blend", "生成速度"]]) {
        const primary = imagePrimaryControls({ ...defaultConfig, model }, imageModelProfile(model!, []));
        expect(primary.detailKey).toBe("quality");
        expect(primary.detailLabel).toBe(label!);
        expect(primary.detailChoices).not.toContain("4k");
    }
});

test("MAI reference mode keeps saved dimensions and resolution inactive without clearing them", () => {
    const model = "mai-image-2.6-flash", profile = imageModelProfile(model, []);
    const config = { ...defaultConfig, model, size: "3:2", imageOptions: '{"resolution":"2k"}' };
    expect(imagePrimaryControls(config, profile, 1)).toMatchObject({ size: "3:2", detailValue: "2k", automatic: true, sizeDisabled: true, detailDisabled: true });
    expect(imagePrimaryControls(config, profile, 0)).toMatchObject({ size: "3:2", detailValue: "2k", automatic: false, sizeDisabled: false, detailDisabled: false });
});

test("GIF exposes frame pixels and quality, never a misleading resolution tier", () => {
    const model = "gpt-image-2.6-flare";
    const primary = imagePrimaryControls({ ...defaultConfig, model, size: "512x512", imageOptions: '{"output_format":"gif","resolution":"4k"}' }, imageModelProfile(model, []));
    expect(primary.sizes).toEqual(["auto", "512x512", "768x768"]);
    expect(primary).toMatchObject({ size: "512x512", detailKey: "quality", detailLabel: "图片质量", exactPixels: false });
});

test("unknown adapter retains disabled channel-default presentation", () => {
    const model = "gemini-3.1-flash-image";
    expect(imagePrimaryControls({ ...defaultConfig, model }, imageModelProfile(model, []))).toMatchObject({ sizeDisabled: true, detailDisabled: true });
});
