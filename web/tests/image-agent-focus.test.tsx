import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageAgentFocus, type ImageAgentFocusImage, type ImageAgentFocusProps } from "@/components/image-agent-focus";
import { canvasThemes } from "@/lib/canvas-theme";

const images: ImageAgentFocusImage[] = [
    { id: "original", label: "原图1", kind: "upload", dataUrl: "/api/assets/11111111-1111-4111-8111-111111111111/content" },
    { id: "version2", label: "图1", kind: "generated", parentId: "original", dataUrl: "/api/assets/22222222-2222-4222-8222-222222222222/content" },
    { id: "version3", label: "图2", kind: "generated", parentId: "version2", dataUrl: "/api/assets/33333333-3333-4333-8333-333333333333/content", note: { summary: "保持针织结构，改成蓝色", keep: ["花边宽度不变"] } },
];
const render = (props: Partial<ImageAgentFocusProps> = {}) => renderToStaticMarkup(<ImageAgentFocus images={images} onSelect={() => { throw new Error("Render must never select an image"); }} onNewCreation={() => { throw new Error("Render must not mutate intent"); }} {...props} />);

test("missing focus stays new creation even when generated versions exist", () => {
    const html = render();
    expect(html).toContain("新创作"); expect(html).toContain("不沿用当前图片");
    expect(html).not.toContain('data-focus-id='); expect(html).not.toContain("作品说明");
});

test("selected focus, lock, version and references are controlled without eager original media", () => {
    const before = JSON.stringify(images);
    const html = render({ focusId: "version3", locked: true, referenceCount: 2 });
    expect(html).toContain('data-focus-id="version3"'); expect(html).toContain("图2 · V3");
    expect(html).toContain("底图已锁定"); expect(html).toContain("参考图 2");
    expect(html).toContain("上一版"); expect(html).toContain(">原图</button>");
    expect(html).toContain("作品说明"); expect(html).toContain("花边宽度不变"); expect(html).toContain("不代表画面已经验收");
    expect(html).not.toContain("/content"); expect(html).not.toContain("/thumb");
    expect(JSON.stringify(images)).toBe(before);
});

test("explicit new creation hides old focus and its notes without erasing the image catalog", () => {
    const html = render({ focusId: "version3", newCreation: true });
    expect(html).toContain("新创作"); expect(html).not.toContain('data-focus-id='); expect(html).not.toContain("花边宽度不变");
    expect(html).toContain('aria-label="选择图片"');
});

test("missing or unreadable ancestor never exposes a fake original action", () => {
    const missing = render({ images: images.slice(1), focusId: "version3" });
    expect(missing).not.toContain(">原图</button>"); expect(missing).toContain("上一版");
    const unavailable = render({ images: images.map(image => image.id === "original" ? { ...image, unavailableReason: "源文件已移除" } : image), focusId: "version3" });
    expect(unavailable).not.toContain(">原图</button>");
    const noBytes = render({ images: images.map(image => image.id === "original" ? { ...image, dataUrl: undefined } : image), focusId: "version3" });
    expect(noBytes).not.toContain(">原图</button>");
});

test("missing focus identity is visible as unavailable and not silently replaced with latest", () => {
    const html = render({ focusId: "missing" });
    expect(html).toContain("图片暂时不可用"); expect(html).not.toContain('data-focus-id='); expect(html).not.toContain("图2 · V3");
});

test("initial theme tokens and child content work without adding a bordered or shadowed wrapper", () => {
    // SSR reads Zustand's initial snapshot; live theme switching is covered in
    // the browser rather than pretending setState changes the server snapshot.
    const html = render({ focusId: "version3", children: <span>context action</span> });
    expect(html).toContain(canvasThemes.light.node.muted); expect(html).toContain(canvasThemes.light.canvas.selectionStroke);
    expect(html).toContain("context action"); expect(html).not.toContain("shadow"); expect(html).not.toContain("border");
});
