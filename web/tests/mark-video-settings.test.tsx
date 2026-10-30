import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoSettingsPanel, videoDurationOptions } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { isHappyHorseVideoConfig } from "@/lib/happyhorse-video";
import { getVideoModelParameterSpec, normalizeVideoModelConfig, videoAspectRatioFollowsImage, videoReferenceError } from "@/lib/video-model-parameters";
import { createVideoGenerationTask } from "@/services/api/video";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { defaultConfig } from "@/stores/use-config-store";
import type { PublicModel } from "@/services/api/business-config";

const markId = "40000000-0000-4000-8000-000000000303";
const markModel = { id: markId, modelId: markId, name: "Mark HappyHorse 1.1", parameterModelId: "happyhorse-1.1", capabilities: ["video"], creditCost: 0, rmbCost: 0 };
const oldModel = { id: "old-happyhorse", modelId: "happyhorse-1.1", name: "happyhorse-1.1", capabilities: ["video"], creditCost: 0, rmbCost: 0 };
const config = { ...defaultConfig, model: markId, videoModel: markId, videoMode: "auto", videoSeconds: "15", vquality: "720P", size: "9:16" };
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalState = useBusinessConfigStore.getState();
afterEach(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; useBusinessConfigStore.setState(originalState); });

function cached(models: PublicModel[]) { useBusinessConfigStore.setState({ status: "ready", models, prices: [], tools: [] }); }
function mockApi(models: PublicModel[], payloads: any[], otherRequests: string[] = []) {
    globalThis.window = { location: { pathname: "/video" } } as Window & typeof globalThis;
    globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url === "/api/models") return Response.json({ models, tools: [], prices: [] });
        if (url === "/api/auth/session") return Response.json({ user: null });
        if (url === "/api/tasks/preflight" || url === "/api/tasks") {
            payloads.push(JSON.parse(String(init?.body)));
            return Response.json(url.endsWith("preflight") ? { ok: true, normalized: {} } : { task: { id: "mark-video-task" } });
        }
        otherRequests.push(url);
        throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
}

describe("Mark UUID video model parameter identity", () => {
    test("cached protocol hint enables HappyHorse controls without changing selection identity", () => {
        cached([oldModel, markModel]);
        expect(getVideoModelParameterSpec(markId)).toEqual(getVideoModelParameterSpec("happyhorse-1.1"));
        expect(isHappyHorseVideoConfig(config)).toBe(true);
        expect(videoAspectRatioFollowsImage(config, 1, "first-frame")).toBe(true);
        expect(normalizeVideoModelConfig({ ...config, videoSeconds: "30", vquality: "2K" })).toMatchObject({ videoSeconds: "5", vquality: "1080P" });
        expect(videoReferenceError(config, Array.from({ length: 10 }, (_, i) => ({ id: `${i}` })) as any)).toContain("最多支持 9 张");
        const html = renderToStaticMarkup(<VideoSettingsPanel config={config} onConfigChange={() => undefined} theme={canvasThemes.light} />);
        expect(videoDurationOptions(getVideoModelParameterSpec(markId)!).map(item => item.value)).toEqual(Array.from({ length: 13 }, (_, index) => String(index + 3)));
        expect(html).toContain('aria-label="视频时长"');
        expect(html).toContain('title="15 秒"');
        expect(html).not.toContain(">生成声音<");
        expect(html).toMatch(/<button[^>]*aria-label="添加水印"[^>]*role="switch"|<button[^>]*role="switch"[^>]*aria-label="添加水印"/);
        expect(config.model).toBe(markId);
    });

    test("fresh API hint, not stale cached hint, controls validation and both request payloads", async () => {
        cached([{ ...markModel, parameterModelId: "doubao-seedance-2.5" }]);
        const payloads: any[] = []; mockApi([oldModel, markModel], payloads);
        await expect(createVideoGenerationTask({ ...config, videoSeconds: "30", vquality: "480p" }, "mock-only")).resolves.toMatchObject({ model: markId });
        expect(payloads).toHaveLength(2);
        for (const payload of payloads) {
            expect(payload.modelConfigId).toBe(markId);
            expect(payload.parameters).toMatchObject({ seconds: 5, resolution: "1080P", size: "9:16" });
            expect(payload.parameters).not.toHaveProperty("generateAudio");
        }
    });

    test("missing fresh hint does not borrow a stale cache or same-name provider model", async () => {
        cached([markModel]);
        const { parameterModelId: _ignored, ...withoutHint } = markModel;
        const payloads: any[] = []; mockApi([oldModel, withoutHint], payloads);
        await expect(createVideoGenerationTask(config, "mock-only")).rejects.toThrow("参数规格");
        expect(payloads).toEqual([]);
    });

    test("removed Mark model cannot fall back to the old HappyHorse provider", async () => {
        cached([markModel]); const payloads: any[] = []; mockApi([oldModel], payloads);
        await expect(createVideoGenerationTask(config, "mock-only")).rejects.toThrow("所选模型暂不可用");
        expect(payloads).toEqual([]);
    });

    test("fresh Mark HappyHorse limits reject unsupported media before any upload or paid submission", async () => {
        cached([{ ...markModel, parameterModelId: "doubao-seedance-2.5" }]);
        const payloads: any[] = [], otherRequests: string[] = []; mockApi([markModel], payloads, otherRequests);
        await expect(createVideoGenerationTask(config, "mock-only", [], [{ id: "video", url: "/api/assets/old/content" }] as any)).rejects.toThrow("不支持视频参考");
        await expect(createVideoGenerationTask(config, "mock-only", [], [], [], undefined, "edit")).rejects.toThrow("不支持视频编辑");
        expect(payloads).toEqual([]); expect(otherRequests).toEqual([]);
    });
});
