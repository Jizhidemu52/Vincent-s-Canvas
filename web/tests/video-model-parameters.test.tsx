import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { VideoSettingsPanel, videoResolutionLabel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { getVideoModelParameterSpec, normalizeVideoModelConfig, videoAspectRatioFollowsImage, videoModelRequestParameters } from "@/lib/video-model-parameters";
import { defaultConfig } from "@/stores/use-config-store";
import { createVideoGenerationTask } from "@/services/api/video";
import { buildVideoProviderRequest, supportedVideoModelIds, videoModelCapabilities } from "../../server/src/video-models";

const configFor = (model: string) => ({ ...defaultConfig, model, videoModel: model });
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });

describe("video model parameter contract", () => {
    test("retains the documented endpoint limits and defaults, independent of the server table", () => {
        const cases = [
            ["MiniMax-H3", [4, 15], ["768P", "2K"], "2K", "16:9", 9, false],
            ["doubao-seedance-2.5", [4, 30], ["480p", "720p", "1080p"], "720p", "adaptive", 30, true],
            ["wan2.7", [2, 15], ["720P", "1080P"], "1080P", "16:9", 2, false],
            ["happyhorse-1.1", [3, 15], ["720P", "1080P"], "1080P", "16:9", 9, false],
        ] as const;
        for (const [model, seconds, resolutions, defaultResolution, defaultSize, maxImages, supportsAudio] of cases) {
            expect(getVideoModelParameterSpec(model)).toMatchObject({ seconds, resolutions, defaultResolution, defaultSize, maxImages, supportsAudio, supportsWatermark: true });
            expect(buildVideoProviderRequest(model, "defaults").body).toMatchObject({ duration: 5, resolution: defaultResolution, watermark: false });
        }
    });

    test("the four UI models match actual server capabilities", () => {
        for (const model of supportedVideoModelIds) {
            const spec = getVideoModelParameterSpec(model)!;
            const capability = videoModelCapabilities[model];
            expect(spec.seconds).toEqual(capability.seconds);
            expect(spec.resolutions).toEqual(capability.resolutions);
            expect(spec.sizes).toEqual(capability.sizes);
            expect(spec.supportsAudio).toBe(capability.supportsAudio);
            expect(spec.supportsWatermark).toBe(capability.supportsWatermark);
            expect(spec.maxImages).toBe(capability.maxImages);
        }
    });

    test("switching models resets unsupported choices instead of submitting stale settings", () => {
        const previous = { ...configFor("default::MiniMax-H3"), size: "adaptive", vquality: "720p", videoSeconds: "30", videoGenerateAudio: "true", videoWatermark: "true" };
        expect(normalizeVideoModelConfig(previous)).toEqual({ size: "16:9", vquality: "2K", videoSeconds: "5", videoGenerateAudio: "false", videoWatermark: "true" });
        expect(videoModelRequestParameters(previous)).toEqual({ seconds: 5, resolution: "2K", size: "16:9", watermark: true });
    });

    test("valid shared choices survive a model switch, including resolution casing", () => {
        expect(normalizeVideoModelConfig({ ...configFor("wan2.7"), size: "9:16", vquality: "720p", videoSeconds: "2" })).toMatchObject({ size: "9:16", vquality: "720P", videoSeconds: "2" });
        expect(normalizeVideoModelConfig({ ...configFor("doubao-seedance-2.5"), size: "auto", vquality: "1080P", videoSeconds: "30" })).toMatchObject({ size: "adaptive", vquality: "1080p", videoSeconds: "30" });
    });

    test("intelligent duration and audio are only offered and submitted for Seedance", () => {
        const seedance = { ...configFor("doubao-seedance-2.5"), videoSeconds: "-1", videoGenerateAudio: "" };
        expect(videoModelRequestParameters(seedance)).toMatchObject({ seconds: -1, generateAudio: true });
        for (const model of ["MiniMax-H3", "wan2.7", "happyhorse-1.1"]) {
            const parameters = videoModelRequestParameters({ ...seedance, model });
            expect(parameters.seconds).toBe(5);
            expect(parameters).not.toHaveProperty("generateAudio");
        }
    });

    test("all selectable durations, resolutions and ratios survive server normalization unchanged", () => {
        for (const model of supportedVideoModelIds) {
            const spec = getVideoModelParameterSpec(model)!;
            const durations = Array.from({ length: spec.seconds[1] - spec.seconds[0] + 1 }, (_, index) => spec.seconds[0] + index);
            if (spec.supportsAutoDuration) durations.push(-1);
            for (const seconds of durations) for (const resolution of spec.resolutions) for (const size of spec.sizes) {
                const parameters = videoModelRequestParameters({ ...configFor(model), videoSeconds: String(seconds), vquality: resolution, size });
                const actual = buildVideoProviderRequest(model, "contract test only", parameters);
                expect({ seconds: actual.duration, resolution: actual.resolution, size: actual.size }).toEqual({ seconds, resolution, size });
            }
        }
    });

    test("invalid duration inputs use a valid model default", () => {
        for (const model of supportedVideoModelIds) for (const videoSeconds of ["", "NaN", "Infinity", "0", "999", "4.5"]) {
            expect(normalizeVideoModelConfig({ ...configFor(model), videoSeconds }).videoSeconds).toBe("5");
        }
    });

    test("unknown model specifications are not fabricated", () => {
        expect(getVideoModelParameterSpec("unknown-video")).toBeUndefined();
        expect(() => videoModelRequestParameters(configFor("unknown-video"))).toThrow("参数规格");
    });

    test("unsupported references and modes fail before uploads, preflight or paid submission", async () => {
        let requests = 0;
        globalThis.fetch = (async () => { requests++; throw new Error("No request should be sent"); }) as typeof fetch;
        for (const model of supportedVideoModelIds) {
            const spec = getVideoModelParameterSpec(model)!;
            await expect(createVideoGenerationTask(configFor(model), "test", Array.from({ length: spec.maxImages + 1 }, (_, index) => ({ id: String(index) })) as any)).rejects.toThrow("最多支持");
            await expect(createVideoGenerationTask(configFor(model), "test", [], [{ id: "video", url: "/api/assets/video/content" }] as any)).rejects.toThrow("尚未接入");
            await expect(createVideoGenerationTask(configFor(model), "test", [], [], [{ id: "audio", url: "/api/assets/audio/content" }] as any)).rejects.toThrow("尚未接入");
        }
        await expect(createVideoGenerationTask(configFor("happyhorse-1.1"), "test", [], [], [], undefined, "edit")).rejects.toThrow("不支持视频编辑");
        await expect(createVideoGenerationTask(configFor("happyhorse-1.1"), "test", [], [], [], undefined, "first-frame")).rejects.toThrow("恰好 1 张");
        await expect(createVideoGenerationTask(configFor("happyhorse-1.1"), "test", [], [], [], undefined, "reference")).rejects.toThrow("需要 1–9 张");
        expect(requests).toBe(0);
    });

    test("HappyHorse reference mode survives both preflight and submission with one image", async () => {
        globalThis.window = { location: { pathname: "/video" } } as Window & typeof globalThis;
        const payloads: Array<Record<string, any>> = [];
        globalThis.fetch = (async (input, init) => {
            const url = String(input);
            if (url === "/api/models") return Response.json({ models: [{ id: "configured-model", modelId: "happyhorse-1.1", name: "happyhorse-1.1" }] });
            if (url === "/api/auth/session") return Response.json({ user: null });
            if (url === "/api/assets/upload-request") return Response.json({ assetId: "reference-image", uploadUrl: null });
            if (url === "/api/tasks/preflight" || url === "/api/tasks") {
                payloads.push(JSON.parse(String(init?.body)));
                return Response.json(url === "/api/tasks/preflight" ? { ok: true, normalized: {} } : { task: { id: "reference-task" } });
            }
            throw new Error(`Unexpected request: ${url}`);
        }) as typeof fetch;
        await createVideoGenerationTask(configFor("happyhorse-1.1"), "reference image", [{ id: "reference", name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,AQ==" }], [], [], undefined, "reference");
        expect(payloads).toHaveLength(2);
        for (const payload of payloads) {
            expect(payload.parameters.happyHorseMode).toBe("reference");
            expect(payload.sourceUrls).toEqual(["/api/assets/reference-image/content"]);
        }
    });

    test("video service uses the same normalized parameters for preflight and task submission", async () => {
        globalThis.window = { location: { pathname: "/canvas/contract-test" } } as Window & typeof globalThis;
        for (const model of supportedVideoModelIds) {
            const config = { ...configFor(model), size: "adaptive", vquality: "480p", videoSeconds: "30", videoGenerateAudio: "true", videoWatermark: "true" };
            const payloads: Array<Record<string, unknown>> = [];
            globalThis.fetch = (async (input, init) => {
                const url = String(input);
                if (url === "/api/models") return Response.json({ models: [{ id: "configured-model", modelId: model, name: model }] });
                if (url === "/api/auth/session") return Response.json({ user: null });
                if (url === "/api/tasks/preflight" || url === "/api/tasks") {
                    payloads.push(JSON.parse(String(init?.body)));
                    return Response.json(url === "/api/tasks/preflight" ? { ok: true, normalized: {} } : { task: { id: "contract-task" } });
                }
                throw new Error(`Unexpected request: ${url}`);
            }) as typeof fetch;
            await expect(createVideoGenerationTask(config, "mocked contract test")).resolves.toMatchObject({ id: "contract-task", model });
            expect(payloads).toHaveLength(2);
            for (const payload of payloads) expect(payload.parameters).toEqual(videoModelRequestParameters(config));
        }
    });
});

describe("model-specific video settings UI", () => {
    const render = (model: string) => renderToStaticMarkup(<VideoSettingsPanel config={configFor(model)} onConfigChange={() => undefined} theme={canvasThemes.light} />);

    test("MiniMax exposes documented watermark but no invented audio switch or pixel inputs", () => {
        const markup = render("MiniMax-H3");
        expect(markup).toContain("768P");
        expect(markup).toContain("2K");
        expect(markup).not.toContain("480p");
        expect(markup).not.toContain("生成声音");
        expect(markup).toContain("添加水印");
        expect(markup).toContain("原生输出带音轨");
        expect(markup).toContain("2–9 张作为参考图");
        expect(markup).not.toContain('type="number"');
    });

    test("Seedance exposes 30 seconds, intelligent duration and documented 1080p", () => {
        const markup = render("doubao-seedance-2.5");
        expect(markup).toContain('value="30"');
        expect(markup).toContain('value="-1"');
        expect(markup).toContain("生成声音");
        expect(markup).toContain("1080p");
        expect(markup).not.toContain("1080P");
    });

    test("Wan and HappyHorse expose their different minimum durations", () => {
        expect(render("wan2.7")).toContain('value="2"');
        expect(render("happyhorse-1.1")).not.toContain('value="2"');
        expect(render("happyhorse-1.1")).toContain('value="3"');
    });

    test("known first-frame input replaces ignored ratio controls with the actual behavior", () => {
        for (const model of ["MiniMax-H3", "wan2.7", "happyhorse-1.1"]) {
            const markup = renderToStaticMarkup(<VideoSettingsPanel config={configFor(model)} onConfigChange={() => undefined} theme={canvasThemes.light} referenceCount={1} />);
            expect(markup).toContain("跟随输入图片，无需设置比例");
            expect(markup).not.toContain(">宽银幕<");
        }
        expect(videoAspectRatioFollowsImage("happyhorse-1.1", 1, "reference")).toBe(false);
        expect(videoAspectRatioFollowsImage("doubao-seedance-2.5", 1)).toBe(false);
        expect(videoAspectRatioFollowsImage("MiniMax-H3", 2)).toBe(false);
        expect(videoAspectRatioFollowsImage("wan2.7", 2)).toBe(true);
    });

    test("resolution labels do not append p to 2K", () => {
        expect(videoResolutionLabel("2K")).toBe("2K");
        expect(videoResolutionLabel("720P")).toBe("720p");
    });
});
