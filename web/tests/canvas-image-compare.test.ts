import { describe, expect, test } from "bun:test";
import { CANVAS_DIFFERENCE_MAX_EDGE, CANVAS_DIFFERENCE_MAX_PIXELS, canvasCompareCandidates, canvasCompareImages, canvasComparePreviewScale, canvasCompareSameImage, canvasCompareSources, canvasDifferenceLayout, canvasDifferenceNotice, canvasDifferencePixels, chooseCanvasComparePair, drawCanvasCompare } from "@/lib/canvas/canvas-image-compare";
import { CanvasNodeType, type CanvasCompareSource, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

const image = (naturalWidth: number, naturalHeight: number) => ({ naturalWidth, naturalHeight } as HTMLImageElement);
const imageNode = (id: string, metadata: CanvasNodeMetadata = {}): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 10, y: 20 }, width: 300, height: 200, metadata: { content: `blob:${id}`, storageKey: `image:${id}`, ...metadata } });
const source = (id: string, label?: string): CanvasCompareSource => ({ type: "image", content: `blob:${id}`, storageKey: `image:${id}`, ...(label ? { label } : {}) });

describe("comparison immutable media identity", () => {
    test("matching storage keys survive changed display URLs and different keys override matching URLs", () => {
        const original = imageNode("before");
        expect(canvasCompareSameImage(original, imageNode("copy", { storageKey: "image:before", content: "blob:rehydrated" }))).toBe(true);
        expect(canvasCompareSameImage(original, imageNode("other", { content: "blob:before" }))).toBe(false);
    });

    test("without both storage keys, only exact nonempty content matches", () => {
        const original = imageNode("before");
        expect(canvasCompareSameImage(original, imageNode("copy", { storageKey: undefined, content: "blob:before" }))).toBe(true);
        expect(canvasCompareSameImage(imageNode("a", { storageKey: undefined, content: "url" }), imageNode("b", { storageKey: undefined, content: "url?other" }))).toBe(false);
        expect(canvasCompareSameImage(imageNode("same", { storageKey: undefined, content: "" }), imageNode("same", { storageKey: undefined, content: "" }))).toBe(false);
        expect(canvasCompareSameImage({ ...original, metadata: undefined }, { ...original, metadata: undefined })).toBe(false);
    });

    test("long identical names, versions, node IDs and geometry never create media identity", () => {
        const name = "款式-".repeat(300);
        const a = imageNode("same", { imageName: name, imageVersion: 8, storageKey: "image:first" });
        const b = imageNode("same", { imageName: name, imageVersion: 8, storageKey: "image:second" });
        expect(canvasCompareSameImage(a, b)).toBe(false);
    });
});

describe("comparison defaults follow the direct saved source", () => {
    test("one selected result defaults to its actual source, not a nearby same-name version", () => {
        const before = imageNode("before", { imageName: "renamed-original", imageVersion: 12, content: "blob:rehydrated-before" });
        const decoy = imageNode("decoy", { imageName: "shirt", imageVersion: 2 });
        const after = imageNode("after", { imageName: "shirt", imageVersion: 3, compareSources: [source("before")] });
        expect(canvasCompareSources([decoy, after, before], after)).toEqual({ images: [before], automatic: true });
        expect(chooseCanvasComparePair([decoy, after, before], ["after"])).toEqual(["before", "after"]);
    });

    test("two distinct explicit selections preserve order even when lineage says otherwise", () => {
        const before = imageNode("before"), after = imageNode("after", { compareSources: [source("before")] }), other = imageNode("other");
        expect(chooseCanvasComparePair([before, after, other], ["after", "other"])).toEqual(["after", "other"]);
        expect(chooseCanvasComparePair([before, after, other], ["missing", "other", "after"])).toEqual(["other", "after"]);
    });

    test("missing selections never fall back to the first image; one image remains on the after side", () => {
        const a = imageNode("a"), b = imageNode("b", { imageName: "a", imageVersion: 2 });
        const text = { ...imageNode("text"), type: CanvasNodeType.Text };
        expect(chooseCanvasComparePair([a, b], [])).toEqual(["", ""]);
        expect(chooseCanvasComparePair([a, b, text], ["missing", "text"])).toEqual(["", ""]);
        expect(chooseCanvasComparePair([a, b], ["a"])).toEqual(["", "a"]);
        expect(canvasCompareImages([text, { ...a, metadata: undefined }])).toEqual([]);
    });

    test("repeated IDs and copies of the same media cannot be compared against themselves", () => {
        const a = imageNode("a"), clone = imageNode("clone", { storageKey: "image:a", content: "blob:other-display-url" }), b = imageNode("b");
        expect(chooseCanvasComparePair([a, clone, b], ["a", "a", "clone"])).toEqual(["", "a"]);
        expect(chooseCanvasComparePair([a, clone, b], ["a", "clone", "b"])).toEqual(["a", "b"]);
        const selfSource = imageNode("result", { storageKey: "image:a", compareSources: [source("a")] });
        expect(canvasCompareSources([a, clone, selfSource], selfSource)).toEqual({ images: [], automatic: false });
        expect(chooseCanvasComparePair([a, clone, selfSource], ["result"])).toEqual(["", "result"]);
    });

    test("multiple inputs never become automatic after filtering missing, repeated or self media", () => {
        const before = imageNode("before");
        for (const sources of [[source("before"), { type: "image" as const, content: "" }], [source("before"), source("before")], [source("before"), source("after")]]) {
            const after = imageNode("after", { compareSources: sources });
            expect(canvasCompareSources([before, after], after)).toEqual({ images: [before], automatic: false });
            expect(chooseCanvasComparePair([before, after], ["after"])).toEqual(["", "after"]);
        }
    });

    test("legacy references are deduplicated manual candidates, and explicit empty snapshots suppress them", () => {
        const before = imageNode("before");
        const after = imageNode("after", { references: ["image:before", "blob:before", "image:before"] });
        expect(canvasCompareSources([before, after], after)).toEqual({ images: [before], automatic: false });
        expect(chooseCanvasComparePair([before, after], ["after"])).toEqual(["", "after"]);
        expect(canvasCompareSources([before, after], { ...after, metadata: { ...after.metadata, compareSources: [] } })).toEqual({ images: [], automatic: false });
        expect(canvasCompareSources([before], { ...after, type: CanvasNodeType.Config })).toEqual({ images: [], automatic: false });
    });
});

describe("persistent comparison snapshot candidates", () => {
    test("a deleted original remains a stable read-only candidate without guessed size or version", () => {
        const label = "原始款式名称".repeat(200);
        const after = imageNode("after", { naturalWidth: 2048, naturalHeight: 1024, imageName: "result", imageVersion: 9, compareSources: [{ type: "image", content: "", storageKey: "image:deleted-original", label }] });
        const snapshot = JSON.stringify(after);
        const restored = JSON.parse(snapshot) as CanvasNodeData;
        const sources = canvasCompareSources([restored], restored);
        expect(sources.automatic).toBe(true); expect(sources.images).toHaveLength(1);
        const before = sources.images[0];
        expect(before.id).toStartWith("canvas-compare-source:"); expect(before.id.length).toBeLessThan(100);
        expect(before.title).toBe(label);
        expect(before.metadata).toEqual({ content: "", storageKey: "image:deleted-original" });
        expect([before.width, before.height]).toEqual([0, 0]);
        expect(canvasCompareCandidates([restored])).toEqual([restored, before]);
        expect(chooseCanvasComparePair([restored], ["after"])).toEqual([before.id, "after"]);
        const renamed = { ...restored, id: "renamed-result", metadata: { ...restored.metadata, compareSources: [{ ...restored.metadata!.compareSources![0], label: "更名" }] } };
        expect(canvasCompareSources([renamed], renamed).images[0].id).toBe(before.id);
        expect(JSON.stringify(after)).toBe(snapshot);
    });

    test("an overwritten node uses the immediate previous snapshot rather than an older surviving original", () => {
        const first = imageNode("first", { imageName: "coat", imageVersion: 1 });
        const current = imageNode("original-node-id", { content: "blob:third", storageKey: "image:third", imageName: "coat", imageVersion: 3, compareSources: [source("second", "直接前版")] });
        const sources = canvasCompareSources([first, current], current);
        expect(sources.automatic).toBe(true);
        expect(sources.images[0].metadata?.storageKey).toBe("image:second");
        expect(sources.images[0].id).not.toBe(current.id);
        expect(sources.images[0].id).not.toBe(first.id);
        expect(chooseCanvasComparePair([first, current], [current.id])).toEqual([sources.images[0].id, current.id]);
    });

    test("originals sharing a display URL but carrying different immutable keys remain distinct", () => {
        const overwritten = imageNode("overwritten", { content: "url:shared", storageKey: "image:new" });
        const current = imageNode("result", { compareSources: [{ type: "image", content: "url:shared", storageKey: "image:old" }] });
        const sources = canvasCompareSources([overwritten, current], current);
        expect(sources.images[0].id).not.toBe(overwritten.id);
        expect(sources.images[0].metadata).toEqual({ content: "url:shared", storageKey: "image:old" });
    });

    test("snapshots shared across results are deduplicated and each default ID resolves in the candidate index", () => {
        const a = imageNode("a", { compareSources: [{ type: "image", content: "url:shared" }] });
        const b = imageNode("b", { compareSources: [{ type: "image", content: "url:shared", storageKey: "image:shared" }] });
        for (const nodes of [[a, b], [b, a]]) {
            const candidates = canvasCompareCandidates(nodes);
            expect(candidates).toHaveLength(3);
            expect(candidates[2].metadata?.storageKey).toBe("image:shared");
            for (const current of nodes) {
                const beforeId = chooseCanvasComparePair(nodes, [current.id])[0];
                expect(candidates.some(candidate => candidate.id === beforeId)).toBe(true);
                expect(canvasCompareSources(nodes, current).images).toHaveLength(1);
            }
        }
    });

    test("a matching persistent node is preferred over an unkeyed URL alias", () => {
        const alias = imageNode("alias", { content: "url:before", storageKey: undefined });
        const before = imageNode("before", { content: "url:before" });
        const after = imageNode("after", { compareSources: [{ type: "image", content: "url:before", storageKey: "image:before" }] });
        expect(canvasCompareSources([alias, before, after], after)).toEqual({ images: [before], automatic: true });
        expect(canvasCompareCandidates([alias, before, after])).toEqual([alias, before, after]);
    });

    test("a URL alias of the current image cannot hide a different keyed original", () => {
        const alias = imageNode("alias", { content: "url:shared", storageKey: undefined });
        const after = imageNode("after", { content: "url:shared", compareSources: [{ type: "image", content: "url:shared", storageKey: "image:before" }] });
        const sources = canvasCompareSources([alias, after], after);
        expect(sources.automatic).toBe(true);
        expect(sources.images[0].metadata?.storageKey).toBe("image:before");
        expect(canvasCompareCandidates([alias, after]).some(candidate => candidate.id === sources.images[0].id)).toBe(true);
        expect(canvasCompareSameImage(sources.images[0], after)).toBe(false);
    });

    test("restoring and deleting an original only changes its node mapping, not the saved source media", () => {
        const after = imageNode("after", { compareSources: [source("before", "修改前")] });
        const other = imageNode("manually-selected-other");
        const initialNodes = [after, other];
        const savedSource = canvasCompareSources(initialNodes, after).images[0];
        const restored = imageNode("restored-source-node", { storageKey: "image:before", content: "blob:rehydrated-before" });
        const restoredNodes = [...initialNodes, restored];
        const mappedSource = canvasCompareSources(restoredNodes, after).images[0];

        expect(mappedSource).toBe(restored);
        expect(mappedSource.id).not.toBe(savedSource.id);
        expect(canvasCompareSameImage(mappedSource, savedSource)).toBe(true);
        expect(canvasCompareCandidates(restoredNodes).some(candidate => candidate.id === savedSource.id)).toBe(false);
        expect(chooseCanvasComparePair(restoredNodes, [after.id])).toEqual([restored.id, after.id]);
        expect(canvasCompareSources(initialNodes, after).images[0].id).toBe(savedSource.id);
        expect(chooseCanvasComparePair(initialNodes, [after.id])).toEqual([savedSource.id, after.id]);
        expect(canvasCompareCandidates(restoredNodes).find(candidate => canvasCompareSameImage(candidate, other))).toBe(other);
    });

    test("overwriting a mapped source node never changes the original stored on its result", () => {
        const before = imageNode("source-node", { storageKey: "image:before", content: "blob:before" });
        const after = imageNode("result", { compareSources: [source("before")] });
        const savedSource = canvasCompareSources([before, after], after).images[0];
        const overwritten = imageNode(before.id, { storageKey: "image:later-edit", content: "blob:later-edit" });
        const nextNodes = [overwritten, after];
        const nextSource = canvasCompareSources(nextNodes, after).images[0];

        expect(savedSource).toBe(before);
        expect(nextSource.id).not.toBe(before.id);
        expect(canvasCompareSameImage(nextSource, savedSource)).toBe(true);
        expect(canvasCompareSameImage(overwritten, savedSource)).toBe(false);
        expect(nextSource.metadata?.storageKey).toBe("image:before");
        expect(canvasCompareCandidates(nextNodes).find(candidate => canvasCompareSameImage(candidate, savedSource))?.id).toBe(nextSource.id);
        expect(chooseCanvasComparePair(nextNodes, [after.id])).toEqual([nextSource.id, after.id]);
        expect(after.metadata?.compareSources).toEqual([source("before")]);
    });
});

describe("bounded original-pixel difference layout", () => {
    test("equal normal-sized sources keep exact decoded pixels", () => {
        expect(canvasDifferenceLayout(image(640, 480), image(640, 480))).toEqual({ width: 640, height: 480, sameSize: true, downsampled: false, pixelExact: true });
    });
    test("different dimensions never claim pixel-exact equality", () => {
        const layout = canvasDifferenceLayout(image(640, 480), image(320, 320));
        expect(layout.pixelExact).toBe(false); expect(layout.sameSize).toBe(false);
        expect(canvasDifferenceNotice(layout)).toContain("非原像素");
        expect(canvasDifferenceNotice(layout)).toContain("按比例居中");
    });
    test("both area and long edge stay bounded, including thin images", () => {
        for (const source of [image(4000, 4000), image(4097, 1), image(1, 99999), image(4097, 1024)]) {
            const layout = canvasDifferenceLayout(source, source);
            expect(layout.width * layout.height).toBeLessThanOrEqual(CANVAS_DIFFERENCE_MAX_PIXELS);
            expect(Math.max(layout.width, layout.height)).toBeLessThanOrEqual(CANVAS_DIFFERENCE_MAX_EDGE);
            expect(Math.min(layout.width, layout.height)).toBeGreaterThanOrEqual(1);
            expect(layout.downsampled).toBe(true); expect(layout.pixelExact).toBe(false);
            expect(canvasDifferenceNotice(layout)).toContain("已降采样");
        }
    });
    test("exact cap is allowed, invalid source sizes reject before allocating", () => {
        expect(canvasDifferenceLayout(image(2000, 2000), image(2000, 2000)).pixelExact).toBe(true);
        for (const width of [0, -1, NaN, Infinity, 1.5]) expect(() => canvasDifferenceLayout(image(width, 1), image(1, 1))).toThrow("尺寸无效");
    });
});

describe("premultiplied RGBA difference", () => {
    test("identical pixels produce opaque black without mutating inputs", () => {
        const input = new Uint8ClampedArray([42, 12, 90, 255, 192, 120, 100, 64]), snapshot = input.slice();
        expect([...canvasDifferencePixels(input, input)]).toEqual([0, 0, 0, 255, 0, 0, 0, 255]); expect(input).toEqual(snapshot);
    });
    test("localized changes retain their exact positions", () => {
        const a = new Uint8ClampedArray(5 * 4); for (let i = 3; i < a.length; i += 4) a[i] = 255;
        const b = a.slice(); b[8] = 91;
        expect([...canvasDifferencePixels(a, b)]).toEqual([0, 0, 0, 255, 0, 0, 0, 255, 91, 91, 91, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    });
    test("fully transparent hidden colors are ignored", () => {
        expect([...canvasDifferencePixels(new Uint8ClampedArray([255, 33, 22, 0]), new Uint8ClampedArray([0, 244, 99, 0]))]).toEqual([0, 0, 0, 255]);
    });
    test("alpha changes remain visible even if both RGB are black", () => {
        expect([...canvasDifferencePixels(new Uint8ClampedArray([0, 0, 0, 0]), new Uint8ClampedArray([0, 0, 0, 128]))]).toEqual([128, 128, 128, 255]);
    });
    test("RGB differences use premultiplied alpha and are symmetric", () => {
        const a = new Uint8ClampedArray([255, 0, 0, 128]), b = new Uint8ClampedArray([0, 0, 0, 128]);
        expect([...canvasDifferencePixels(a, b)]).toEqual([128, 128, 128, 255]); expect(canvasDifferencePixels(a, b)).toEqual(canvasDifferencePixels(b, a));
    });
    test("invalid buffers and over-cap allocations reject", () => {
        expect(() => canvasDifferencePixels(new Uint8ClampedArray(4), new Uint8ClampedArray(8))).toThrow("尺寸不一致");
        expect(() => canvasDifferencePixels(new Uint8ClampedArray(3), new Uint8ClampedArray(3))).toThrow("尺寸不一致");
        const large = new Uint8ClampedArray((CANVAS_DIFFERENCE_MAX_PIXELS + 1) * 4);
        expect(() => canvasDifferencePixels(large, large)).toThrow("上限");
    });
});

test("fit uses both viewport dimensions; 1x/2x/4x are CSS output-pixel scales", () => {
    expect(canvasComparePreviewScale(1000, 1048, 350, 300, "fit")).toBeCloseTo(300 / 1048);
    expect(canvasComparePreviewScale(100, 100, 350, 300, "fit")).toBe(1);
    for (const zoom of [1, 2, 4] as const) expect(canvasComparePreviewScale(1000, 1048, 350, 300, zoom)).toBe(zoom);
});

test("difference renderer reads separate transparent surfaces and writes opaque grayscale without a header", () => {
    const inputs = [new Uint8ClampedArray([255, 0, 0, 0, 100, 90, 50, 255]), new Uint8ClampedArray([0, 255, 0, 0, 150, 90, 50, 255])];
    let reads = 0; const clears: number[][] = [], draws: number[][] = []; let output: Uint8ClampedArray | undefined;
    const context = {
        clearRect: (...args: number[]) => clears.push(args),
        drawImage: (_image: unknown, ...args: number[]) => draws.push(args),
        getImageData: () => ({ data: inputs[reads++].slice() }),
        putImageData: (data: { data: Uint8ClampedArray }) => { output = data.data.slice(); },
    };
    const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
    drawCanvasCompare(canvas, image(2, 1), image(2, 1), "difference", 17, "#fff", "#000");
    expect([canvas.width, canvas.height]).toEqual([2, 1]);
    expect(clears).toEqual([[0, 0, 2, 1], [0, 0, 2, 1]]); expect(draws).toEqual([[0, 0, 2, 1], [0, 0, 2, 1]]);
    expect([...(output || [])]).toEqual([0, 0, 0, 255, 50, 50, 50, 255]);
    expect([...inputs[0]]).toEqual([255, 0, 0, 0, 100, 90, 50, 255]);
});

test("difference read failures are surfaced and existing modes can still draw after recovery", () => {
    let draws = 0;
    const context = { clearRect() {}, drawImage() { draws++; }, getImageData() { throw new DOMException("Cross-origin", "SecurityError"); }, fillRect() {}, save() {}, restore() {}, fillText() {} };
    const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
    expect(() => drawCanvasCompare(canvas, image(2, 1), image(2, 1), "difference", 50, "#fff", "#000")).toThrow("Cross-origin");
    drawCanvasCompare(canvas, image(2, 1), image(2, 1), "side", 50, "#fff", "#000");
    expect([canvas.width, canvas.height]).toEqual([1600, 1048]); expect(draws).toBe(3);
});
