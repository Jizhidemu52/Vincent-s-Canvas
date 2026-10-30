import { describe, expect, test } from "bun:test";
import { generationDownloadName, generationErrorDiagnostic, generationErrorMessage, shouldConfirmPromptReuse } from "../src/lib/generation-feedback";
import { snapshotVideoRequest } from "../src/pages/video/video-retry";
import { defaultConfig } from "../src/stores/use-config-store";

describe("generation interaction safety", () => {
    test("reusing a different prompt requires confirmation only for a nonempty draft", () => {
        expect(shouldConfirmPromptReuse("正在写下一条", "历史提示词")).toBe(true);
        expect(shouldConfirmPromptReuse("", "历史提示词")).toBe(false);
        expect(shouldConfirmPromptReuse("相同输入", "相同输入")).toBe(false);
    });
    test("the video retry snapshot cannot be altered through current config or reference objects", () => {
        const current = { text: "原始任务", config: { ...defaultConfig, videoModel: "original-model", videoSeconds: "8", size: "9:16" }, references: [{ id: "a", name: "original.png", type: "image/png", dataUrl: "data:original", storageKey: "original-bytes" }], videoReferences: [], audioReferences: [] };
        const original = snapshotVideoRequest(current);
        current.text = "正在写下一条";
        current.config.videoModel = "different-model";
        current.config.videoSeconds = "10";
        current.references[0]!.dataUrl = "data:changed";
        expect(original.text).toBe("原始任务");
        expect(original.config.videoModel).toBe("original-model");
        expect(original.config.videoSeconds).toBe("8");
        expect(original.references[0]?.dataUrl).toBe("data:original");
        expect(original.references[0]?.storageKey).toBe("original-bytes");
    });
    test("unknown paid submissions always request original task lookup", () => {
        const result = generationErrorMessage("原任务状态待核查，勿重复生成；Failed to fetch", 500);
        expect(result).toContain("继续查询原任务");
        expect(result).toContain("不要重复生成");
    });
    test.each([[401, "登录已过期"], [402, "额度不足"], [429, "服务请求较多"], [504, "响应超时"], [503, "暂时不可用"]])("HTTP %s maps to actionable Chinese guidance", (status, expected) => {
        expect(generationErrorMessage("upstream error", Number(status))).toContain(String(expected));
    });
    test("network failures retain their raw cause for diagnostic copying", () => {
        const original = new TypeError("Failed to fetch");
        const error = new Error(generationErrorMessage(original), { cause: original });
        expect(error.message).toContain("网络连接失败");
        expect(generationErrorDiagnostic(error)).toContain("Failed to fetch");
    });
    test("download filenames distinguish versions and times and remove filesystem-unsafe characters", () => {
        const a = generationDownloadName('作品/一:二', "mp4", new Date("2026-01-01T00:00:00Z"));
        const b = generationDownloadName('作品/一:二', "mp4", new Date("2026-01-01T00:00:01Z"));
        expect(a).toStartWith("作品_一_二_v1_");
        expect(a).toEndWith(".mp4");
        expect(a).not.toBe(b);
        expect(a).not.toMatch(/[<>:"/\\|?*]/);
    });
});
