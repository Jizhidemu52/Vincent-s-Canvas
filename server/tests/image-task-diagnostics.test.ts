import { describe, expect, test } from "bun:test";
import { imageTaskApiReplacer, imageTaskFailureDetail, imageTaskPauseReason } from "../src/image-task-diagnostics";

describe("safe image task failure details", () => {
  test("records only approved codes and HTTP statuses, never provider text or nested secrets", () => {
    const error = Object.assign(new Error("https://secret.invalid/result?key=secret-key"), {
      code: "PROVIDER_POLL_HTTP_ERROR", httpStatus: 503, apiKey: "secret-key", cause: { url: "secret-url" },
    });
    expect(imageTaskFailureDetail(error, "polling")).toEqual({ phase: "polling", code: "PROVIDER_POLL_HTTP_ERROR", httpStatus: 503 });
    expect(imageTaskFailureDetail({ code: "secret-key", httpStatus: 403, message: "secret-url" }, "download"))
      .toEqual({ phase: "download", code: "PROVIDER_OPERATION_FAILED" });
    expect(imageTaskFailureDetail({ code: "ECONNRESET", httpStatus: 403 }, "download"))
      .toEqual({ phase: "download", code: "ECONNRESET" });
    for (const status of [NaN, 99, 600, 403.5, "403"]) {
      expect(imageTaskFailureDetail({ code: "RESULT_DOWNLOAD_HTTP_ERROR", httpStatus: status }, "download").httpStatus).toBeUndefined();
    }
    expect(imageTaskFailureDetail(new DOMException("secret-key", "TimeoutError"), "polling").code).toBe("OPERATION_TIMEOUT");
  });

  test("hides cached URLs at every nesting depth but preserves task status and phase", () => {
    const task = { status: "paused", upstreamResultUrl: "https://secret.invalid/signed", lastFailure: { phase: "download", code: "ECONNRESET" } };
    const result = JSON.parse(JSON.stringify({ task, tasks: [task], history: [{ ...task }] }, imageTaskApiReplacer));
    expect(result.task).toEqual({ status: "paused", lastFailure: task.lastFailure });
    expect(result.tasks[0].upstreamResultUrl).toBeUndefined();
    expect(result.history[0].upstreamResultUrl).toBeUndefined();
    expect(imageTaskPauseReason("download")).toContain("下载原结果");
    expect(imageTaskPauseReason("polling")).toContain("同一任务");
    expect(imageTaskPauseReason("result_store")).toContain("保存原结果");
  });
});
