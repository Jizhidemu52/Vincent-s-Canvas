import { describe, expect, test } from "bun:test";
import { generationDownloadName, generationErrorDiagnostic, generationErrorMessage, imageResultProcessingFailureMessage, mergeGenerationDiagnostics, shouldConfirmPromptReuse } from "../src/lib/generation-feedback";
import { snapshotVideoRequest } from "../src/pages/video/video-retry";
import { defaultConfig } from "../src/stores/use-config-store";
import { publicTaskFailurePayload } from "../../shared/generation-error";

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
        expect(result).toContain("请稍后再试");
        expect(result).toContain("刷新进度不会重新生成");
        expect(result).not.toMatch(/待核查|尚未确认|生成失败/);
    });
    test("task upload-limit guidance survives the API and result-display formatting", () => {
        for (const purpose of ["图片", "视频"]) {
            const raw = `APIMart 参考图上传失败（429），尚未提交${purpose}生成`;
            const payload = publicTaskFailurePayload({ task: { status: "failed", failureReason: raw } }) as { task: { failureReason: string } };
            const shown = generationErrorMessage(new Error(payload.task.failureReason));
            expect(shown).toBe(`参考图上传已被服务商限制，尚未提交${purpose}生成；请联系管理员检查上传配额，恢复后再试。`);
            expect(generationErrorMessage(new Error(raw))).toBe(shown);
            expect(shown).not.toMatch(/服务繁忙|已提交的任务/);
        }
    });
    test("an unrecoverable submission keeps the investigation guidance instead of promising recovery", () => {
        const result = generationErrorMessage("upstream HTTP 500，提交结果待核查，暂无法恢复上游查询。请勿重复提交。");
        expect(result).toContain("管理员协助");
        expect(result).toContain("刷新进度");
        expect(result).not.toContain("继续查询原任务");
    });
    test("local postprocessing failure is not rewritten as an uncertain upstream query", () => {
        for (const error of ["渠道原件已保存到素材库，但图片后处理未完成：decoder failed", imageResultProcessingFailureMessage,
            Object.assign(new Error("private decoder detail"), { code: "IMAGE_RESULT_PROCESSING_FAILED" })]) {
            const shown = generationErrorMessage(error);
            expect(shown).toBe(imageResultProcessingFailureMessage);
            expect(shown).not.toMatch(/decoder|刷新进度|继续查询|查询暂停/);
        }
        expect(generationErrorMessage("unknown detail", 500, "IMAGE_RESULT_PROCESSING_FAILED")).toBe(imageResultProcessingFailureMessage);
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
    test("only explicit pre-submission codes override generic HTTP 503 guidance", () => {
        expect(generationErrorMessage("管理员尚未启用此场景的配方版本，未提交生成", 503, "PROMPT_RECIPE_UNAVAILABLE")).toContain("尚未提交生成");
        expect(generationErrorMessage("未提交生成", 503, "UNRECOGNIZED_ERROR")).not.toContain("尚未提交生成");
        expect(generationErrorMessage("connection lost", 503)).toContain("查询原任务");
    });
    test("diagnostic context preserves lookup identifiers without serializing task data", () => {
        const error = Object.assign(new Error("安全失败原因"), { taskId: "actual-task", requestId: "actual-request", task: { prompt: "private input", parameters: { secret: "private-value" } } });
        const diagnostic = generationErrorDiagnostic(error, { taskId: "fallback-task", requestId: "fallback-request" });
        expect(diagnostic).toContain("taskId: actual-task");
        expect(diagnostic).toContain("requestId: actual-request");
        expect(diagnostic).not.toContain("private");
        expect(diagnostic).not.toContain("fallback");
        expect(generationErrorDiagnostic(new Error("尚未提交"), { requestId: "prepared-request" })).toContain("requestId: prepared-request");
    });
    test("nested diagnostic and card context keep identical lookup identifiers only once", () => {
        const cause = Object.assign(new Error("original diagnostic"), { taskId: "same-task", requestId: "same-request" });
        const error = Object.assign(new Error("display message", { cause }), { taskId: "same-task", requestId: "same-request", code: "IMAGE_RESULT_PROCESSING_FAILED" });
        const text = mergeGenerationDiagnostics(generationErrorDiagnostic(error), "taskId: same-task\r\nrequestId: same-request", "raw repeated line\nraw repeated line");
        expect(text.match(/^taskId: same-task$/gm)).toHaveLength(1);
        expect(text.match(/^requestId: same-request$/gm)).toHaveLength(1);
        expect(text).toContain("original diagnostic");
        expect(text).toContain("code: IMAGE_RESULT_PROCESSING_FAILED");
        expect(text.match(/^raw repeated line$/gm)).toHaveLength(2);
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
