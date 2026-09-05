import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasQuickGeneratePanel } from "@/components/canvas/canvas-quick-generate-panel";
import { defaultConfig } from "@/stores/use-config-store";

const noop = () => undefined;
function render(count: number, running = false) {
    return renderToStaticMarkup(<CanvasQuickGeneratePanel embedded open prompt="修改花瓶颜色" model="gpt-image-2" size="1:1" quality="auto" onQualityChange={noop} count={1} running={running} config={defaultConfig} estimateCredits={0} estimateRmb={0}
        references={Array.from({ length: count }, (_, index) => ({ id: String(index), name: `reference-${index}`, type: "image/png", dataUrl: `data:image/png;base64,${index}` }))}
        onClose={noop} onPromptChange={noop} onModelChange={noop} onSizeChange={noop} onCountChange={noop} onPickReferences={noop} onRemoveReference={noop} onClearReferences={noop} onMoveReference={noop} onMissingConfig={noop} onGenerate={noop} />);
}
test("the same composer switches between creation and editing with numbered references", () => {
    expect(render(0)).toContain("点击或框选画布图片");
    const markup = render(2);
    expect(markup).toContain("生成修改图");
    expect(markup).toContain("参考图 1：reference-0，点击调整顺序");
    expect(markup).toContain("参考图 2：reference-1，点击调整顺序");
    expect(markup).toContain("生成新图并保留原图");
});
test("too many references remain visible but cannot be submitted", () => {
    const markup = render(17);
    expect(markup).toContain("参考图 17：reference-16");
    expect(markup).toContain('role="alert"');
    expect(markup).toMatch(/class="cw-generate-button" disabled=""/);
});
test("an in-flight edit locks reference removal, sorting and duplicate submission", () => {
    const markup = render(2, true);
    expect(markup).toMatch(/aria-label="移除参考图 1" disabled=""/);
    expect(markup).toMatch(/class="cw-generate-button" disabled=""/);
    expect(markup).toContain("生成中…");
});
