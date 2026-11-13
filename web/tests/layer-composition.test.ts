import { test } from "node:test";
import assert from "node:assert/strict";
import type { LayerStudioResultDocument } from "../../shared/layer-studio";
import { createLayerStudioEditDocument, hitLayerStudioItem, initialLayerStudioRect, layerStudioBoxRect, layerStudioGroups,
    layerStudioPoint, moveLayerStudioOrder, orderedLayerStudioItems, renderLayerStudioComposition, scaleLayerStudioEdit,
    updateLayerStudioEdit, validLayerStudioSize } from "../src/pages/layer-studio/layer-composition";

const fixture = (): LayerStudioResultDocument => ({ version: 1, taskId: "task-a", mode: "decompose", status: "ready", expectedOutputCount: 3, items: [
    { index: 0, groupIndex: 0, urlIndex: 0, role: "base", state: "saved", width: 200, height: 100 },
    { index: 1, groupIndex: 0, urlIndex: 1, role: "layer", state: "saved", width: 20, height: 40, boundingBox: { absolute: [40, 10, 100, 50] } },
    { index: 2, groupIndex: 0, urlIndex: 2, role: "layer", state: "saved", width: 30, height: 20 },
] });
test("absolute placement uses base coordinates rather than original layer resolution", () => {
    const result = fixture(), edit = createLayerStudioEditDocument(result);
    assert.deepEqual(edit.layers[1], { index: 1, x: 40, y: 10, width: 60, height: 40, visible: true, order: 1 });
    assert.deepEqual(initialLayerStudioRect(result.items[2], { width: 200, height: 100 }), { x: 85, y: 40, width: 30, height: 20 });
    assert.equal(result.items[2].boundingBox, undefined);
});
test("normalized coordinates and malformed metadata have honest fallbacks", () => {
    assert.deepEqual(layerStudioBoxRect({ normalized: [250, 100, 750, 800] }, { width: 200, height: 100 }), { x: 50, y: 10, width: 100, height: 70 });
    assert.equal(layerStudioBoxRect({ absolute: [0, 0, 250, 100] }, { width: 200, height: 100 }), null);
    assert.equal(initialLayerStudioRect({ ...fixture().items[2], width: undefined }, { width: 200, height: 100 }), null);
    const missing = fixture(); missing.items[0].width = undefined;
    assert.equal(layerStudioGroups(missing)[0].size, null);
    assert.deepEqual(layerStudioGroups(missing, new Map([[0, { width: 200, height: 100 }]]))[0].size, { width: 200, height: 100 });
});
test("draft validation prevents cross task reuse and strips unrequested fields", () => {
    const result = fixture(), original = createLayerStudioEditDocument(result);
    const changed = updateLayerStudioEdit(original, 1, { x: 80, visible: false });
    assert.equal(createLayerStudioEditDocument(result, changed).layers[1].x, 80);
    assert.equal(createLayerStudioEditDocument({ ...result, taskId: "another" }, changed).layers[1].x, 40);
    const unsafe = { ...changed, layers: changed.layers.map(layer => ({ ...layer, privateUrl: "secret" })) };
    assert.equal("privateUrl" in createLayerStudioEditDocument(result, unsafe).layers[0], false);
    const invalid = { ...changed, layers: changed.layers.map(layer => ({ ...layer, width: NaN })) };
    assert.equal(createLayerStudioEditDocument(result, invalid).layers[1].width, 60);
    assert.throws(() => updateLayerStudioEdit(original, 1, { height: 0 }));
    assert.throws(() => updateLayerStudioEdit(original, 1, { x: Infinity }));
});
test("newly saved layers preserve earlier edits; groups keep their own order", () => {
    const result = fixture(), edit = updateLayerStudioEdit(createLayerStudioEditDocument(result), 1, { x: 71 });
    const more = { ...result, expectedOutputCount: 5, items: [...result.items, { ...result.items[0], index: 3, groupIndex: 1 }, { ...result.items[1], index: 4, groupIndex: 1 }] };
    const next = createLayerStudioEditDocument(more, edit), groups = layerStudioGroups(more);
    assert.equal(next.layers.find(layer => layer.index === 1)?.x, 71);
    const ordered = moveLayerStudioOrder(next, groups[0], 1, 1);
    assert.deepEqual(orderedLayerStudioItems(groups[0], ordered).map(item => item.index), [0, 2, 1]);
    assert.deepEqual(ordered.layers.filter(layer => [3, 4].includes(layer.index)), next.layers.filter(layer => [3, 4].includes(layer.index)));
});
test("CSS pointer mapping, hidden hit test and centered scaling are consistent", () => {
    const result = fixture(), group = layerStudioGroups(result)[0], edit = createLayerStudioEditDocument(result);
    assert.deepEqual(layerStudioPoint({ clientX: 60, clientY: 45 }, { left: 10, top: 20, width: 100, height: 50 }, group.size!), { x: 100, y: 50 });
    assert.equal(hitLayerStudioItem(group, edit, { x: 90, y: 45 })?.index, 2);
    assert.equal(hitLayerStudioItem(group, updateLayerStudioEdit(edit, 2, { visible: false }), { x: 90, y: 45 })?.index, 1);
    assert.deepEqual(scaleLayerStudioEdit(edit.layers[1], 120, 80), { x: 10, y: -10, width: 120, height: 80 });
});
test("100 layers are supported while invalid or excessive canvases are refused", () => {
    const result = fixture(); result.items = Array.from({ length: 100 }, (_, index) => ({ ...result.items[index ? 1 : 0], index, urlIndex: index })); result.expectedOutputCount = 100;
    assert.equal(createLayerStudioEditDocument(result).layers.length, 100);
    assert.equal(validLayerStudioSize({ width: 6000, height: 6000 }), true);
    assert.equal(validLayerStudioSize({ width: 6001, height: 6000 }), false);
    assert.equal(validLayerStudioSize({ width: -1, height: 40 }), false);
});
test("preview and export share exact transforms and strict export rejects missing originals", async () => {
    const result = fixture(), edit = createLayerStudioEditDocument(result), group = layerStudioGroups(result)[0];
    const drawn: unknown[][] = [], disposed: number[] = [];
    const context = { clearRect() {}, setTransform() {}, drawImage(...args: unknown[]) { drawn.push(args); }, imageSmoothingQuality: "" };
    const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
    await renderLayerStudioComposition(canvas, result, edit, group, async item => ({ width: item.width!, height: item.height!, image: item.index as unknown as CanvasImageSource, dispose: () => disposed.push(item.index) }));
    assert.deepEqual(drawn, [[0, 0, 0, 200, 100], [1, 40, 10, 60, 40], [2, 85, 40, 30, 20]]);
    assert.deepEqual(disposed, [0, 1, 2]);
    result.status = "partial"; result.items[2].state = "pending";
    await assert.rejects(renderLayerStudioComposition(canvas, result, edit, group, async () => { throw new Error("not reached"); }));
    const preview = await renderLayerStudioComposition(canvas, result, edit, group, async item => ({ width: 1, height: 1, image: item.index as unknown as CanvasImageSource, dispose() {} }), { allowPartial: true });
    assert.deepEqual(preview.unavailable.map(item => item.index), [2]);
    assert.equal(preview.unavailable[0].message, "图层原件尚未保存，请查询或恢复原任务保存");
});
