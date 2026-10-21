import { describe, expect, test } from "bun:test";
import { initializeCanvas, readPsd, writePsd } from "ag-psd";
import { buildLayerMaskPrompt, generatePlannedPatternLayer, layerMaskCoverage, partitionPatternLayers, rememberPatternLayerPlan, type PatternLayer, type PatternLayerAiTrace } from "@/pages/creative/pattern-layers-model";

const source = { width: 3, height: 2, data: new Uint8ClampedArray([
    255,0,0,255, 0,255,0,200, 0,0,255,255,
    40,50,60,255, 90,100,110,120, 140,150,160,0,
]) };
const mask = (indices: number[]) => ({ width: 3, height: 2, data: new Uint8ClampedArray(Array.from({ length: 6 }, (_, i) => indices.includes(i) ? [255,255,255,255] : [0,0,0,255]).flat()) });
const layer = (name: string): PatternLayer => ({ id: name, name, maskUrl: "", maskMode: "luminance", threshold: 128, visible: true, opacity: 1, x: 0, y: 0 });
initializeCanvas(() => { throw new Error("Pixel-only PSD test must not use canvas rendering"); }, (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" }));

describe("editable pattern layers", () => {
    test("keeps source colors/alpha and partitions overlapping selections without duplicated pixels", () => {
        const result = partitionPatternLayers(source, [{ layer: layer("red-green"), mask: mask([0, 1]) }, { layer: layer("green"), mask: mask([1, 4]) }]);
        expect(result[1]!.image.width).toBe(1);
        expect([...result[1]!.image.data]).toEqual([255, 0, 0, 255]);
        expect(result[2]!.left).toBe(1);
        expect([...result[2]!.image.data]).toEqual([0, 255, 0, 200, 90, 100, 110, 120]);
        const rebuilt = new Uint8ClampedArray(source.data.length);
        for (const item of result) for (let y = 0; y < item.image.height; y++) for (let x = 0; x < item.image.width; x++) {
            const offset = (y * item.image.width + x) * 4;
            if (!item.image.data[offset + 3]) continue;
            rebuilt.set(item.image.data.subarray(offset, offset + 4), ((item.top + y) * source.width + item.left + x) * 4);
        }
        for (let i = 0; i < 6; i++) if (source.data[i * 4 + 3]) expect([...rebuilt.subarray(i * 4, i * 4 + 4)]).toEqual([...source.data.subarray(i * 4, i * 4 + 4)]);
    });
    test("interprets painted alpha separately from generated luminance and rejects invalid dimensions", () => {
        const blue = { width: 1, height: 1, data: new Uint8ClampedArray([42,119,246,255]) };
        expect([...layerMaskCoverage(blue, "alpha", 128)]).toEqual([1]);
        expect([...layerMaskCoverage(blue, "luminance", 128)]).toEqual([0]);
        expect(() => partitionPatternLayers(source, [{ layer: layer("bad"), mask: blue }])).toThrow("尺寸");
    });
    test("exports a real multilayer PSD with offsets, transparency and independent pixels that read back", () => {
        const items = partitionPatternLayers(source, [{ layer: { ...layer("绿色"), x: 2, y: -1, opacity: .5, visible: false }, mask: mask([1, 4]) }]);
        const bytes = writePsd({ width: 3, height: 2, children: items.map(item => ({ name: item.name, left: item.left, top: item.top, hidden: !item.visible, opacity: item.opacity, imageData: item.image })) });
        expect(String.fromCharCode(...new Uint8Array(bytes).slice(0, 4))).toBe("8BPS");
        const result = readPsd(bytes, { useImageData: true, skipCompositeImageData: true });
        expect(result.children).toHaveLength(2);
        const green = result.children![1]!;
        expect(green).toMatchObject({ name: "绿色", left: 3, top: -1, hidden: true });
        expect(green.opacity).toBeCloseTo(.5, 2);
        expect([...green.imageData!.data]).toEqual([0,255,0,200,90,100,110,120]);
    });
    test("requires an explicit target and forbids recoloring artwork in the mask task", () => {
        expect(() => buildLayerMaskPrompt(" ")).toThrow();
        expect(buildLayerMaskPrompt("花朵")).toContain("不要输出原图颜色");
    });
});

describe("planned pattern layer generation", () => {
    const plan = { summary: "提取红色花朵", prompt: `已识别前景红色花朵。\n${buildLayerMaskPrompt("红色花朵")}`, observations: ["原图包含红花与绿叶"], preserve: ["保留花瓣孔洞"], warnings: [], modelId: "configured-llm-uuid", modelName: "Configured LLM", requestId: "analysis-request" };
    const identity = { sourceId: "source", targetLabel: "红色花朵", imageModelId: "configured-image-uuid", imageModelName: "Configured image", imageRequestId: "image-request" };

    test("persists the actual plan and distinct model identities before using its final prompt for the image", async () => {
        const events: string[] = [];
        let saved: PatternLayerAiTrace | undefined;
        const result = await generatePlannedPatternLayer({ ...identity, isCurrent: () => true,
            analyze: async () => { events.push("analysis"); return plan; },
            persist: async trace => { events.push("persist"); saved = JSON.parse(JSON.stringify(trace)); },
            generate: async trace => { events.push("image"); expect(saved).toEqual(trace); expect(trace.plan.prompt).toBe(plan.prompt); return ["mask-result"]; },
        });
        expect(events).toEqual(["analysis", "persist", "image"]);
        expect(result.result).toEqual(["mask-result"]);
        expect(result.trace).toMatchObject({ ...identity, plan });
        const restoredLayer = JSON.parse(JSON.stringify({ ...layer("红色花朵"), aiTrace: result.trace })) as PatternLayer;
        expect(restoredLayer.aiTrace?.plan).toEqual(plan);
    });

    test("analysis failure never persists a fake plan or submits an image", async () => {
        let saved = false, generated = false;
        await expect(generatePlannedPatternLayer({ ...identity, isCurrent: () => true,
            analyze: async () => { throw new Error("LLM unavailable"); },
            persist: async () => { saved = true; }, generate: async () => { generated = true; },
        })).rejects.toThrow("LLM unavailable");
        expect(saved).toBe(false); expect(generated).toBe(false);
    });

    test("accepted-task updates keep one history entry while later attempts retain earlier plans", () => {
        const original = { ...identity, plan, createdAt: 1 };
        const updated = { ...original, imageModelName: "Updated actual model" };
        const next = { ...original, imageRequestId: "next-image-request", createdAt: 2 };
        const history = rememberPatternLayerPlan(rememberPatternLayerPlan([original], updated), next);
        expect(history).toEqual([updated, next]);
        expect(JSON.parse(JSON.stringify(history))).toEqual(history);
    });

    test("empty LLM instructions and failed trace persistence both block image submission", async () => {
        let generated = false;
        for (const invalidPlan of [true, false]) {
            await expect(generatePlannedPatternLayer({ ...identity, isCurrent: () => true,
                analyze: async () => invalidPlan ? { ...plan, prompt: " " } : plan,
                persist: async () => { throw new Error("storage unavailable"); }, generate: async () => { generated = true; },
            })).rejects.toThrow(invalidPlan ? "LLM 未返回有效分层指令" : "storage unavailable");
        }
        expect(generated).toBe(false);
    });

    test("navigation or account changes during analysis or persistence cannot start an image", async () => {
        for (const changeDuring of ["analysis", "persist"]) {
            let current = true, generated = false;
            await expect(generatePlannedPatternLayer({ ...identity, isCurrent: () => current,
                analyze: async () => { if (changeDuring === "analysis") current = false; return plan; },
                persist: async () => { if (changeDuring === "persist") current = false; },
                generate: async () => { generated = true; },
            })).rejects.toThrow("当前分层工程已变化");
            expect(generated).toBe(false);
        }
    });
});
