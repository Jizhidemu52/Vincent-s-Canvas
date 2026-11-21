import { expect, test } from "bun:test";
import { assertResultConsistent, restoreSceneObservation, sceneFailureTitle, sceneObservation, scenePendingTitle } from "../src/pages/creative/scene-result-state";

test("query snapshots carry only original identity across uncertainty, optimization, generation and local errors", () => {
    const identity = { id: "result", requestId: "request:0" };
    const ready = sceneObservation(identity, { status: "failed", failureKind: "uncertain", compilationId: "old-compilation", error: "等待继续生成" });
    const pending = sceneObservation(ready, { status: "pending", progress: "preparing", error: "正在准备提示词，请稍候。" });
    expect(pending).toMatchObject({ ...identity, status: "pending", failureKind: undefined, compilationId: undefined, recovery: undefined });
    expect(scenePendingTitle(pending)).toBe("正在准备提示词");
    const generated = sceneObservation(pending, { taskId: "task", status: "pending", progress: "generating" });
    expect(generated.error).toBeUndefined();
    expect(scenePendingTitle(generated)).toBe("图片生成中");
    const waiting = sceneObservation(generated, { status: "failed", failureKind: "uncertain", pausedKind: "submission_unknown", recovery: "investigate" });
    expect(waiting).toMatchObject({ taskId: "task", progress: undefined, compilationId: undefined });
    expect(sceneFailureTitle(waiting)).toBe("提交结果待核查");
    expect(() => assertResultConsistent({ ...generated, failureKind: "uncertain" })).toThrow();
    expect(() => assertResultConsistent({ ...waiting, status: "success" })).toThrow();
});

test("an old mixed card never presents stale preparation copy as the diagnosis of an unconfirmed result", () => {
    const restored = restoreSceneObservation({ id: "result", requestId: "r", status: "failed", failureKind: "uncertain", error: "正在准备提示词，请稍候。" });
    expect(restored.error).toBe("正在查询原任务，不会重新生成。");
    expect(restored.requestId).toBe("r");
});
