import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultVideoMotionSettings, normalizeVideoMotionSettings, videoMotionGroups } from "../../shared/video-motion-options";
import { createVideoMotionInput, motionVideoConfig, videoMotionSummary } from "@/pages/video/video-motion";
import { VideoMotionPanel } from "@/pages/video/video-motion-panel";
import { snapshotVideoRequest } from "@/pages/video/video-retry";
import { defaultConfig } from "@/stores/use-config-store";
import { createQueuedMediaTaskPayloads, QueuedTaskSubmissionUncertainError, submitQueuedMediaTask } from "@/services/api/generation-tasks";
import english from "@/lib/i18n/en";

const config = { ...defaultConfig, model: "doubao-seedance-2.5", videoModel: "doubao-seedance-2.5" };
const counts = (images = 0, videos = 0, audios = 0) => ({ images, videos, audios });
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });

describe("standalone video motion", () => {
    test("new defaults include a selectable Seedance model without modifying saved config", () => {
        expect(defaultConfig.videoModel).toBe("default::doubao-seedance-2.5");
        expect(defaultConfig.videoModels).toContain(defaultConfig.videoModel);
        expect(defaultConfig.channels[0]!.models).toContain("doubao-seedance-2.5");
        const saved = { ...config, model: "wan2.7", videoModel: "wan2.7", videoSeconds: "10", size: "9:16", vquality: "1080P" };
        expect(motionVideoConfig(saved, defaultVideoMotionSettings, counts(1), true)).toMatchObject({ model: "wan2.7", videoModel: "wan2.7", videoSeconds: "10", size: "9:16", vquality: "1080P" });
        expect(saved.videoMode).toBe("auto");
    });
    test("automatic Seedance uses first frame, first/last frame and leaves other material modes intact", () => {
        expect(motionVideoConfig(config, defaultVideoMotionSettings, counts(1), true)).toMatchObject({ videoMode: "first-frame", size: "adaptive", videoGenerateAudio: "false" });
        expect(motionVideoConfig(config, defaultVideoMotionSettings, counts(2), true)).toMatchObject({ videoMode: "first-last-frame", size: "adaptive" });
        expect(motionVideoConfig(config, defaultVideoMotionSettings, counts(3), true).videoMode).toBe("reference");
        expect(motionVideoConfig(config, defaultVideoMotionSettings, counts(), true).videoMode).toBe("text");
        expect(motionVideoConfig({ ...config, videoMode: "reference" }, defaultVideoMotionSettings, counts(1), true).videoMode).toBe("reference");
        expect(motionVideoConfig(config, defaultVideoMotionSettings, counts(1, 1), true).videoMode).toBe("auto");
        expect(motionVideoConfig(config, defaultVideoMotionSettings, counts(1), false).videoMode).toBe("auto");
    });
    test("audio settings produce the actual output parameter", () => {
        for (const audio of ["none", "ambient", "music"]) {
            expect(motionVideoConfig(config, { ...defaultVideoMotionSettings, audio }, counts(1), true).videoGenerateAudio).toBe(audio === "none" ? "false" : "true");
        }
    });
    test("blank descriptions are valid motion input and reference roles follow the actual mode", () => {
        const normalized = motionVideoConfig(config, defaultVideoMotionSettings, counts(2), true);
        expect(createVideoMotionInput("", defaultVideoMotionSettings, normalized, counts(2))).toMatchObject({
            scene: "video-motion", mode: "video", userText: "", outputLanguage: "zh", referenceRoles: ["首帧", "尾帧"],
            fields: { video_mode: "first-last-frame", duration: 5, resolution: "720p", ratio: "adaptive", generate_audio: false },
        });
        const input = createVideoMotionInput("让她动起来", defaultVideoMotionSettings, normalized, counts(2));
        const payloads = createQueuedMediaTaskPayloads({ requestId: "request", projectId: "video", operationType: "video_generation", modelConfigId: "model", prompt: input.userText, promptInput: input, sourceUrls: ["/api/assets/a/content", "/api/assets/b/content"] });
        expect(payloads[0]?.promptInput).toEqual(input);
        expect(payloads[1]?.promptInput).toEqual(input);
    });
    test("option limits and persisted malformed values normalize without retaining arbitrary fields", () => {
        expect(normalizeVideoMotionSettings({ subject_action: ["turn", "walk", "turn", "touch"], audio: "auto", camera: "invented", keep: ["color", "unknown"], privateRule: "never persisted" })).toEqual({ ...defaultVideoMotionSettings, subject_action: ["turn", "walk"], keep: ["color"] });
        const snapshot = snapshotVideoRequest({ text: "", promptInput: createVideoMotionInput("", defaultVideoMotionSettings, config, counts()), config, references: [], videoReferences: [], audioReferences: [] });
        (snapshot.promptInput!.fields.keep as string[]).push("background");
        expect(defaultVideoMotionSettings.keep).not.toContain("background");
    });
    test("summary supports public task output and restart history metadata", () => {
        expect(videoMotionSummary({ summaryZh: "缓慢推近" })).toBe("缓慢推近");
        expect(videoMotionSummary({ parameters: { promptOptimization: { summaryZh: "自然转身" } } })).toBe("自然转身");
        expect(videoMotionSummary({ parameters: { promptOptimization: "invalid" } })).toBeUndefined();
    });
    test("panel contains public vocabulary, starts folded and has translated options", () => {
        const html = renderToStaticMarkup(<VideoMotionPanel value={defaultVideoMotionSettings} onChange={() => {}} />);
        expect(html).toContain("动效设置（可选）");
        expect(html).not.toContain('<details open');
        for (const group of videoMotionGroups) for (const option of group.options) {
            expect(english[option.label as keyof typeof english]).toBeTruthy();
            expect(english[option.description as keyof typeof english]).toBeTruthy();
        }
    });
});

describe("motion planner submission uncertainty", () => {
    test.each([true, false])("a lost POST acknowledgement only queries its original request (found=%s)", async found => {
        globalThis.window = { location: { pathname: "/video" } } as Window & typeof globalThis;
        const calls: Array<{ path: string; method: string }> = [];
        let requestId = "";
        globalThis.fetch = (async (url, init) => {
            const path = String(url), method = init?.method || "GET";
            calls.push({ path, method });
            if (path === "/api/tasks/preflight") return Response.json({ ok: true, normalized: {} });
            if (path === "/api/tasks" && method === "POST") {
                requestId = JSON.parse(String(init?.body)).requestId;
                throw new TypeError("lost acknowledgement");
            }
            if (path.startsWith("/api/tasks/by-request/")) return Response.json({ task: found ? { id: "original", requestId, status: "waiting", resultUrls: [] } : null });
            throw new Error(`Unexpected ${method} ${path}`);
        }) as typeof fetch;
        const request = submitQueuedMediaTask({ operationType: "video_generation", modelId: "doubao-seedance-2.5", toolKey: "video", prompt: "", promptInput: createVideoMotionInput("", defaultVideoMotionSettings, config, counts()), resolvedModel: { id: "model", modelId: "doubao-seedance-2.5", name: "Seedance", capabilities: ["video"], creditCost: 0, rmbCost: 0 } });
        if (found) expect(await request).toMatchObject({ id: "original", requestId });
        else await expect(request).rejects.toBeInstanceOf(QueuedTaskSubmissionUncertainError);
        expect(calls.filter(call => call.path === "/api/tasks" && call.method === "POST")).toHaveLength(1);
        expect(calls.filter(call => call.method === "GET")).toEqual([{ path: `/api/tasks/by-request/${encodeURIComponent(requestId)}`, method: "GET" }]);
    });
});
