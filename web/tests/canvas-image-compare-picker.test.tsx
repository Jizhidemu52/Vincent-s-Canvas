import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, title = id): CanvasNodeData => ({ id, title, type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { content: `blob:${id}`, storageKey: `image:${id}` } });
function elements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}
function harness(file: string, name: string) {
    const url = new URL(`../src/components/canvas/${file}.tsx`, import.meta.url), requireModule = createRequire(url);
    const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const values: any[] = []; let cursor = 0;
    const module = { exports: {} as Record<string, Function> };
    const dependencies: Record<string, any> = {
        react: { ...React, useEffect() {}, useMemo: (factory: Function) => factory(), useRef: (initial: unknown) => { const index = cursor++; return values[index] ||= { current: initial }; }, useState: (initial: any) => { const index = cursor++; if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial; return [values[index], (next: any) => { values[index] = typeof next === "function" ? next(values[index]) : next; }]; } },
        antd: { App: { useApp: () => ({ message: { error() {} } }) }, Input: "Input", Popover: "Popover", Button: "Button", Modal: "Modal", Segmented: "Segmented", Slider: "Slider", Spin: "Spin" },
        "@/stores/use-theme-store": { useThemeStore: (select: Function) => select({ theme: "light" }) },
        "./use-canvas-image-thumbnail": { useCanvasImageThumbnail: (image: CanvasNodeData) => ({ url: image.metadata?.content || "", thumbnail: true }) },
        "./canvas-image-compare-picker": { CanvasCompareThumbnail: "Thumbnail", CanvasImageComparePicker: "ComparePicker", canvasCompareImageLabel: (image: CanvasNodeData) => image.metadata?.imageName || image.metadata?.originalFileName || image.title },
    };
    new Function("require", "module", "exports", code)((key: string) => dependencies[key] || requireModule(key), module, module.exports);
    return { render(props: any) { cursor = 0; return elements(module.exports[name](props)); } };
}
const byLabel = (tree: ReactElement<any>[], label: string) => tree.find(element => element.props["aria-label"] === label)!;
const popoverPicker = (tree: ReactElement<any>[], index = 0) => elements(tree.filter(element => element.type === "Popover")[index].props.content).find(element => element.type === "ComparePicker")!;

test("large thumbnail cards preserve long names, group the direct source first and expose selection without color alone", () => {
    const longName = "春夏款式修改前上一个版本完整名称".repeat(10);
    const original = node("before", longName), other = node("other", "其他图");
    let chosen = "";
    const page = harness("canvas-image-compare-picker", "CanvasImageComparePicker");
    const tree = page.render({ images: [other, original], sourceIds: [original.id], preferredId: original.id, selectedId: original.id, onChoose: (image: CanvasNodeData) => { chosen = image.id; }, onClose() {} });
    const cards = tree.filter(element => element.props["data-compare-candidate"]);
    expect(cards.map(card => card.props["data-compare-candidate"])).toEqual(["before", "other"]);
    expect(cards[0].props["aria-pressed"]).toBe(true);
    expect(cards[0].props.title).toBe(longName);
    expect(cards[0].props["aria-label"]).toContain(longName);
    expect(elements(cards[0]).some(element => [element.props.children].flat().includes("已选中"))).toBe(true);
    expect(elements(cards[0]).some(element => element.props.className === "block h-32")).toBe(true);
    cards[1].props.onClick(); expect(chosen).toBe("other");
    expect(byLabel(tree, "搜索对比图片").props.autoFocus).toBe(true);
});

test("candidate search handles long names, versions and empty matches without hiding the selected label", () => {
    const page = harness("canvas-image-compare-picker", "CanvasImageComparePicker");
    const image = node("a", "加长文件名称_针织帽_AW27"); image.metadata!.imageVersion = 12;
    const props = { images: [image, node("b", "丝巾")], onChoose() {}, onClose() {} };
    let tree = page.render(props);
    byLabel(tree, "搜索对比图片").props.onChange({ target: { value: " aw27 " } });
    expect(page.render(props).filter(element => element.props["data-compare-candidate"]).map(element => element.props["data-compare-candidate"])).toEqual(["a"]);
    byLabel(page.render(props), "搜索对比图片").props.onChange({ target: { value: "v12" } });
    expect(page.render(props).filter(element => element.props["data-compare-candidate"])).toHaveLength(1);
    byLabel(page.render(props), "搜索对比图片").props.onChange({ target: { value: "不存在" } });
    tree = page.render(props);
    expect(tree.filter(element => element.props["data-compare-candidate"])).toHaveLength(0);
    expect(tree.find(element => element.props.role === "status")?.props.children).toContain("没有匹配");
});

test("candidate keyboard navigation supports arrows, row movement, Home/End and Escape", () => {
    let closed = 0, focused = -1, prevented = 0;
    const page = harness("canvas-image-compare-picker", "CanvasImageComparePicker");
    const tree = page.render({ images: [node("a"), node("b"), node("c"), node("d")], onChoose() {}, onClose() { closed++; } });
    const grid = tree.find(element => element.type === "div" && element.props.onKeyDown)!;
    const buttons = Array.from({ length: 4 }, (_, index) => ({ offsetTop: Math.floor(index / 2) * 180, offsetLeft: index % 2 * 200, focus() { focused = index; } }));
    const key = (value: string, index: number) => grid.props.onKeyDown({ key: value, target: buttons[index], currentTarget: { querySelectorAll: () => buttons }, preventDefault() { prevented++; } });
    key("ArrowRight", 0); expect(focused).toBe(1);
    key("ArrowDown", 0); expect(focused).toBe(2);
    key("ArrowUp", 3); expect(focused).toBe(1);
    key("End", 0); expect(focused).toBe(3);
    key("Home", 3); expect(focused).toBe(0);
    expect(prevented).toBe(5);
    tree[0].props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} }); expect(closed).toBe(1);
    // Native buttons provide Enter/Space activation, without canvas shortcut propagation.
    expect(tree.filter(element => element.props["data-compare-candidate"]).every(element => element.type === "button" && element.props.type === "button")).toBe(true);
});

test("inline comparison defaults to the saved previous image, excludes itself and accepts a later manual selection", () => {
    const original = node("before", "直接上版"), result = node("after", "修改后"), other = node("other");
    result.metadata!.compareSources = [{ type: "image", content: "blob:before", storageKey: "image:before" }];
    const page = harness("canvas-inline-image-compare", "CanvasInlineImageCompare");
    let advancedSource: string | undefined;
    const props = { node: result, nodes: [result, other, original, { ...result, id: "duplicate" }], scale: 0.2, showImageInfo: false, onAdvanced(sourceId?: string) { advancedSource = sourceId; } };
    let tree = page.render(props), picker = popoverPicker(tree);
    expect(picker.props.selectedId).toBe("before"); expect(picker.props.preferredId).toBe("before");
    expect(picker.props.images.map((image: CanvasNodeData) => image.id)).toEqual(["before", "other"]);
    expect(tree.some(element => element.type === "select")).toBe(false);
    picker.props.onChoose(other); tree = page.render(props); picker = popoverPicker(tree);
    expect(picker.props.selectedId).toBe("other");
    tree.find(element => element.type === "button" && element.props.children === "更多")!.props.onClick();
    expect(advancedSource).toBe("other");
    expect(picker.props.sourceIds).toEqual(["before"]);
    const popover = tree.find(element => element.type === "Popover")!;
    expect(popover.props.content.props.style.width).toBe("min(600px, calc(100vw - 56px))");
    expect(popover.props.destroyOnHidden).toBe(true);
    expect(byLabel(tree, "选择对比原图").props.style.padding * props.scale).toBe(6);
    const zoomed = page.render({ ...props, scale: 2 });
    expect(zoomed.find(element => element.type === "Popover")!.props.content.props.style.width).toBe(popover.props.content.props.style.width);
});

test("restoring a source node cannot overwrite the inline manual choice or lose the dialog's saved original", () => {
    const result = node("after"), other = node("other"), restored = node("before");
    result.metadata!.compareSources = [{ type: "image", content: "blob:before", storageKey: "image:before" }];
    const inline = harness("canvas-inline-image-compare", "CanvasInlineImageCompare");
    const props = { node: result, nodes: [result, other], scale: 1, showImageInfo: false, onAdvanced() {} };
    popoverPicker(inline.render(props)).props.onChoose(other);
    expect(popoverPicker(inline.render({ ...props, nodes: [result, other, restored] })).props.selectedId).toBe("other");
    const dialog = harness("canvas-image-compare-dialog", "CanvasImageCompareDialog");
    const dialogProps = { nodes: [result], initialIds: [result.id], onClose() {} };
    const first = popoverPicker(dialog.render(dialogProps), 0).props.selectedId;
    expect(first.startsWith("canvas-compare-source:")).toBe(true);
    const remapped = popoverPicker(dialog.render({ ...dialogProps, nodes: [result, restored] }), 0);
    expect(remapped.props.selectedId).toBe("before");
    expect(remapped.props.preferredId).toBe("before");
});

test("an overwritten selected node cannot redirect either dialog side to its new image bytes", () => {
    const original = node("before"), result = node("after");
    result.metadata!.compareSources = [{ type: "image", content: "blob:before", storageKey: "image:before" }];
    const dialog = harness("canvas-image-compare-dialog", "CanvasImageCompareDialog");
    const props = { nodes: [original, result], initialIds: [result.id], onClose() {} };
    dialog.render(props);
    const overwritten = { ...original, metadata: { content: "blob:after", storageKey: "image:after" } };
    const tree = dialog.render({ ...props, nodes: [overwritten, result] });
    const beforePicker = popoverPicker(tree, 0);
    expect(beforePicker.props.images.find((image: CanvasNodeData) => image.id === beforePicker.props.selectedId).metadata.storageKey).toBe("image:before");
    const afterPicker = popoverPicker(tree, 1);
    expect(afterPicker.props.images.find((image: CanvasNodeData) => image.id === afterPicker.props.selectedId).metadata.storageKey).toBe("image:after");
});

test("unrelated same-name images never activate comparison and a changed result resets a manual choice", () => {
    const result = node("after", "同名"), other = node("other", "同名");
    const page = harness("canvas-inline-image-compare", "CanvasInlineImageCompare");
    const props = { node: result, nodes: [other, result], scale: 1, showImageInfo: false, onAdvanced() {} };
    let tree = page.render(props);
    expect(popoverPicker(tree).props.selectedId).toBeUndefined();
    expect(tree.some(element => element.props.children === "未记录修改前图片，可手动选择")).toBe(true);
    popoverPicker(tree).props.onChoose(other); expect(popoverPicker(page.render(props)).props.selectedId).toBe("other");
    const updated = { ...result, metadata: { ...result.metadata, storageKey: "image:new", content: "blob:new", compareSources: [{ type: "image" as const, content: "blob:after", storageKey: "image:after" }] } };
    tree = page.render({ ...props, node: updated, nodes: [other, updated] });
    expect(popoverPicker(tree).props.selectedId).toBe(popoverPicker(tree).props.preferredId);
    expect(popoverPicker(tree).props.selectedId).not.toBe("other");
});

test("full dialog labels before/after correctly, offers thumbnails and preserves manual before choice on reselection", () => {
    const original = node("before"), result = node("after"), other = node("other");
    result.metadata!.compareSources = [{ type: "image", content: "blob:before", storageKey: "image:before" }];
    const page = harness("canvas-image-compare-dialog", "CanvasImageCompareDialog");
    const props = { nodes: [other, result, original], initialIds: [result.id], onClose() {} };
    let tree = page.render(props);
    expect(popoverPicker(tree, 0).props.selectedId).toBe("before");
    expect(popoverPicker(tree, 1).props.selectedId).toBe("after");
    expect(elements(byLabel(tree, "选择改款前图片")).some(element => element.type === "Thumbnail")).toBe(true);
    popoverPicker(tree, 0).props.onChoose(other); tree = page.render(props);
    popoverPicker(tree, 1).props.onChoose(result); tree = page.render(props);
    expect(popoverPicker(tree, 0).props.selectedId).toBe("other");
    expect(tree.find(element => element.type === "Button" && element.props.children === "恢复直接上版")).toBeDefined();
});

test("an inline manual snapshot selection is retained when opening the advanced dialog", () => {
    const result = node("after");
    result.metadata!.compareSources = [{ type: "image", content: "blob:shape", label: "款式参考" }, { type: "image", content: "blob:pattern", label: "图案参考" }];
    const inline = harness("canvas-inline-image-compare", "CanvasInlineImageCompare");
    let sourceId: string | undefined;
    const inlineProps = { node: result, nodes: [result], scale: 1, showImageInfo: false, onAdvanced(id?: string) { sourceId = id; } };
    const picker = popoverPicker(inline.render(inlineProps));
    expect(picker.props.selectedId).toBeUndefined();
    picker.props.onChoose(picker.props.images[1]);
    inline.render(inlineProps).find(element => element.type === "button" && element.props.children === "更多")!.props.onClick();
    const dialog = harness("canvas-image-compare-dialog", "CanvasImageCompareDialog");
    const tree = dialog.render({ nodes: [result], initialIds: [sourceId!, result.id], onClose() {} });
    expect(popoverPicker(tree, 0).props.selectedId).toBe(sourceId);
    expect(popoverPicker(tree, 1).props.selectedId).toBe(result.id);
});
