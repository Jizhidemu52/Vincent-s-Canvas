import { describe, expect, test } from "bun:test";
import { syncCanvasSelectionReferences, type CanvasSelectionReference } from "@/lib/canvas/canvas-selection-references";
import { moveImageReference, validateImageReferences } from "@/lib/image-reference-policy";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const image = (id: string, metadata = {}): CanvasNodeData => ({ id, title: id, type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 120, height: 120, metadata: { content: `blob:${id}`, storageKey: `stored-${id}`, ...metadata } });
const red = image("red"), blue = image("blue"), green = image("green");
const byId = new Map([red, blue, green].map((node) => [node.id, node]));
const sync = (refs: CanvasSelectionReference[], ids: string[], map = byId) => syncCanvasSelectionReferences(refs, new Set(ids), map);

describe("canvas selection reference composition", () => {
    test("single click uses the selected image and selecting another replaces it", () => {
        const selected = sync([], ["red"]);
        expect(selected[0]).toMatchObject({ id: "canvas:red", canvasNodeId: "red", dataUrl: "blob:red", storageKey: "stored-red" });
        expect(sync(selected, ["blue"]).map((ref) => ref.canvasNodeId)).toEqual(["blue"]);
    });
    test("box selection includes every usable image, excluding text, video and pending images", () => {
        const mixed = new Map(byId);
        mixed.set("text", { ...red, id: "text", type: CanvasNodeType.Text });
        mixed.set("video", { ...red, id: "video", type: CanvasNodeType.Video });
        mixed.set("pending", image("pending", { content: undefined, storageKey: undefined }));
        expect(sync([], Array.from(mixed.keys()), mixed).map((ref) => ref.canvasNodeId)).toEqual(["red", "blue", "green"]);
    });
    test("manual order survives canvas moves, zoom and unchanged selection; new selection appends", () => {
        const selected = moveImageReference(sync([], ["red", "blue"]), 1, 0);
        const movedMap = new Map(byId);
        movedMap.set("red", { ...red, position: { x: 999, y: 25 } });
        expect(sync(selected, ["red", "blue"], movedMap)).toBe(selected);
        expect(sync(selected, ["red", "blue", "green"]).map((ref) => ref.canvasNodeId)).toEqual(["blue", "red", "green"]);
        expect(buildImageReferencePromptText("保留图1构图，改成图2的颜色", selected)).toContain("图片1、图片2");
        expect(selected.map((reference) => reference.storageKey)).toEqual(["stored-blue", "stored-red"]);
    });
    test("removing or clearing selected references does not resurrect them, uploads remain independent", () => {
        const upload = { id: "upload", name: "uploaded.png", type: "image/png", dataUrl: "blob:upload" };
        const refs = sync([upload], ["red", "blue"]);
        expect(sync(refs, ["blue"]).map((ref) => ref.id)).toEqual(["upload", "canvas:blue"]);
        expect(sync([upload], [])).toEqual([upload]);
        expect(sync([], [])).toEqual([]);
    });
    test("clicking blank canvas or a non-image node keeps the edit reference draft", () => {
        const refs = sync([], ["red"]);
        expect(sync(refs, [])).toBe(refs);
        const mixed = new Map(byId); mixed.set("text", { ...red, id: "text", type: CanvasNodeType.Text });
        expect(sync(refs, ["text"], mixed)).toBe(refs);
        expect(sync(refs, [], new Map())).toBe(refs);
    });
    test("a deselected edit draft still receives the latest saved image", () => {
        const refs = sync([], ["red"]);
        const fresh = new Map(byId); fresh.set("red", image("red", { storageKey: "edited-red", content: "blob:edited-red" }));
        expect(sync(refs, [], fresh)[0]).toMatchObject({ storageKey: "edited-red", dataUrl: "blob:edited-red" });
    });
    test("refreshes persisted media identity without resetting reference order", () => {
        const refs = moveImageReference(sync([], ["red", "blue"]), 0, 1);
        const fresh = new Map(byId); fresh.set("red", image("red", { content: "blob:restored-red" }));
        const next = sync(refs, ["red", "blue"], fresh);
        expect(next[0]).toBe(refs[0]);
        expect(next[1]!.dataUrl).toBe("blob:restored-red");
    });
    test("never silently truncates a large box selection; model validation gates submission", () => {
        const map = new Map(Array.from({ length: 17 }, (_, index) => { const node = image(String(index)); return [node.id, node]; }));
        const selected = sync([], Array.from(map.keys()), map);
        expect(selected).toHaveLength(17);
        expect(validateImageReferences("gpt-image-2", selected).valid).toBe(false);
    });
});
