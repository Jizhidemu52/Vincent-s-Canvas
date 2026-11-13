import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import ts from "typescript";
import { formatDuration } from "@/lib/image-utils";
import { completedVideoTaskDurationMs } from "@/pages/video/video-task-duration";

const pageSource = readFileSync(new URL("../src/pages/video/index.tsx", import.meta.url), "utf8");

/** Exercise the real page's completion path without mounting its unrelated controls. */
function pageFunction(name: string, scope: Record<string, unknown>) {
    const source = ts.createSourceFile("video.tsx", pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let initializer: ts.Expression | ts.FunctionDeclaration | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer;
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) initializer = node;
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (!initializer) throw new Error(`Missing page function ${name}`);
    const code = ts.transpileModule(`const run = ${initializer.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
    return new Function(...Object.keys(scope), `${code}\nreturn run;`)(...Object.values(scope));
}

async function finishRecoveredVideo(completed: Record<string, unknown>, newSubmission = false) {
    const saved: Array<Record<string, any>> = [];
    const noop = () => {};
    const scope = {
        activeLogIdsRef: { current: new Set() },
        visibleResultLogIdsRef: { current: new Set() },
        observationControllers: { current: new Map() },
        mountedRef: { current: true },
        user: { id: "owner" },
        useUserStore: { getState: () => ({ user: { id: "owner" } }) },
        previewLogRef: { current: null },
        previewLoader: { invalidate: noop },
        setPreviewLoading: noop, setResults: noop, setHistoryResults: noop, setResultView: noop, setRunning: noop, setActiveTaskId: noop, setStartedAt: noop,
        waitForTasks: async (ids: string[]) => {
            expect(ids).toEqual(["original-paid-task"]);
            return [completed];
        },
        storeGeneratedVideo: async () => ({ url: "blob:existing-result", storageKey: "video:existing-result", width: 1280, height: 720, bytes: 100, mimeType: "video/mp4" }),
        videoMotionSummary: () => "",
        nanoid: () => "restored-video",
        useAssetStore: { getState: () => ({ assets: [] }) },
        addAsset: () => "local-result",
        saveLog: async (log: Record<string, unknown>) => { saved.push(log); },
        message: { success: noop, warning: noop },
        uiText: (value: string) => value,
        completedVideoTaskDurationMs,
        Date: { now: () => Date.parse("2026-11-10T08:26:12.073Z") },
    };
    const poll = pageFunction("pollGenerationLog", scope);
    const originalLog = {
        id: "old-local-log", createdAt: Date.parse("2026-11-10T07:50:48.073Z"),
        task: { id: "original-paid-task", provider: "server", model: "video-model" },
        prompt: "original prompt", model: "video-model", status: "查询暂停",
    };
    if (newSubmission) {
        let completion: Promise<void> | undefined;
        await pageFunction("generate", {
            ...scope, draftReady: true, logsReady: true, workspaceId: "workspace",
            setPreviewError: noop, setSubmitting: noop, setPreviewLog: noop, setLogs: noop,
            buildRequestSnapshot: () => ({ text: originalLog.prompt, config: { model: originalLog.model }, references: [], videoReferences: [], audioReferences: [] }),
            buildLog: (value: Record<string, unknown>) => ({ ...originalLog, task: undefined, ...value }),
            workbenchSubmissions: { acquire: () => noop },
            createVideoGenerationTask: async (_config: unknown, _prompt: unknown, _images: unknown, _videos: unknown, _audio: unknown, options: any) => {
                await options.onSubmissionStarted("new-request");
                return originalLog.task;
            },
            logStore: { setItem: async () => {} }, serializeLog: (value: unknown) => value,
            logRefreshRevisionRef: { current: 0 }, upsertGenerationLog: noop,
            pollGenerationLog: (...args: unknown[]) => { completion = poll(...args); },
        })();
        await completion;
    } else await poll(originalLog);
    return saved.at(-1);
}

test("a late video recovery saves the server's 8m44.752s task duration, not 35m24s of browser observation", async () => {
    const log = await finishRecoveredVideo({
        id: "original-paid-task", status: "success", resultUrls: ["/api/assets/original/content"],
        queuedAt: "2026-11-10T07:50:48.073Z", startedAt: "2026-11-10T07:50:49.000Z", completedAt: "2026-11-10T07:59:32.825Z",
    });
    expect(log?.status).toBe("成功");
    expect(log?.durationMs).toBe(524752);
});

test("a successful production task with no completed timestamp keeps an unknown duration", async () => {
    const log = await finishRecoveredVideo({
        id: "original-paid-task", status: "success", resultUrls: ["/api/assets/original/content"],
        queuedAt: "2026-11-10T07:50:48.073Z", completedAt: null,
        createdAt: "2026-11-10T07:00:00.000Z", updatedAt: "2026-11-10T08:00:00.000Z",
    });
    expect(log?.status).toBe("成功");
    expect(log?.durationMs).toBeNull();
});

test("demo video completion uses its recorded terminal updatedAt, not the later browser clock", async () => {
    const log = await finishRecoveredVideo({
        id: "original-paid-task", status: "success", resultUrls: ["/api/assets/original/content"],
        createdAt: "2026-11-10T07:50:48.073Z", updatedAt: "2026-11-10T07:59:32.825Z",
    });
    expect(log?.durationMs).toBe(524752);
});

test.each([524752, null])("a newly submitted video uses the same server timing contract: %s", async duration => {
    const log = await finishRecoveredVideo({
        id: "original-paid-task", status: "success", resultUrls: ["/api/assets/original/content"],
        queuedAt: "2026-11-10T07:50:48.073Z", completedAt: duration === null ? null : "2026-11-10T07:59:32.825Z",
    }, true);
    expect(log?.status).toBe("成功");
    expect(log?.durationMs).toBe(duration);
});

function treeText(node: unknown): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(treeText).join("");
    return React.isValidElement<{ children?: unknown }>(node) ? treeText(node.props.children) : "";
}

test("an unknown completed duration survives history normalization and is explicitly displayed as unknown", () => {
    const normalized = pageFunction("normalizeLog", {
        normalizeLogConfig: () => ({}), getUiLocale: () => "zh-CN",
        normalizeResolution: (value: string) => value,
    })({ id: "record", createdAt: 1, durationMs: null, status: "成功" });
    expect(normalized.durationMs).toBeNull();
    const card = pageFunction("LogCard", {
        React, useUiText() {}, uiText: (value: string) => value,
        DisplayText: ({ text }: { text: string }) => text,
        Tag: "tag", Checkbox: "input", videoResolutionLabel: (value: string) => value, formatDuration,
    })({ log: normalized, selected: false, active: false, onSelectedChange() {}, onClick() {} });
    expect(treeText(card)).toContain("耗时未知");
});

test.each([undefined, NaN, Infinity, -1])("an absent or invalid saved video duration is not normalized to a made-up zero: %s", durationMs => {
    const normalized = pageFunction("normalizeLog", {
        normalizeLogConfig: () => ({}), getUiLocale: () => "zh-CN", normalizeResolution: (value: string) => value,
    })({ id: "record", createdAt: 1, durationMs, status: "成功" });
    expect(normalized.durationMs).toBeNull();
});

test("server queue-to-completion time wins over processing, pre-queue preparation and demo timestamps", () => {
    expect(completedVideoTaskDurationMs({
        status: "success", queuedAt: "2026-11-10T07:50:48.073Z", startedAt: "2026-11-10T07:51:00.000Z", completedAt: "2026-11-10T07:59:32.825Z",
        createdAt: "2026-11-10T07:40:00.000Z", updatedAt: "2026-11-10T08:30:00.000Z",
    })).toBe(524752);
});

test("missing, invalid or reversed production timestamps cannot borrow a demo or observation duration", () => {
    const demoTimes = { createdAt: "2026-11-10T07:00:00.000Z", updatedAt: "2026-11-10T08:00:00.000Z" };
    for (const times of [
        { queuedAt: null, completedAt: "2026-11-10T07:59:32.825Z" },
        { queuedAt: "2026-11-10T07:50:48.073Z", completedAt: undefined },
        { queuedAt: "invalid", completedAt: "2026-11-10T07:59:32.825Z" },
        { queuedAt: "2026-11-10T07:50:48.073Z", completedAt: "invalid" },
        { queuedAt: "", completedAt: "2026-11-10T07:59:32.825Z" },
        { queuedAt: "2026-11-10T08:00:00.000Z", completedAt: "2026-11-10T07:59:32.825Z" },
        { startedAt: "2026-11-10T07:50:48.073Z" },
    ]) expect(completedVideoTaskDurationMs({ status: "success", ...demoTimes, ...times })).toBeNull();
    expect(completedVideoTaskDurationMs({ status: "success" })).toBeNull();
});

test("only terminal success has a completed duration, and a measured zero remains distinct from unknown", () => {
    const times = { queuedAt: "2026-11-10T07:50:48.073Z", completedAt: "2026-11-10T07:50:48.073Z" };
    expect(completedVideoTaskDurationMs({ status: "success", ...times })).toBe(0);
    for (const status of ["waiting", "processing", "paused", "failed", "cancelled"]) {
        expect(completedVideoTaskDurationMs({ status, ...times })).toBeNull();
    }
});

test.each([true, false])("video recovery action remains restricted to the original task: canRecover=%s", canRecover => {
    const card = pageFunction("FailedVideoCard", {
        React, useUiText() {}, uiText: (value: string) => value,
        Button: "button", GenerationDiagnostic: "diagnostic", GenerationTaskCancel: "cancel",
    })({ error: "detail", recovery: { canRecover }, onRetry() {} });
    expect(treeText(card)).toContain(canRecover ? "继续获取结果" : "需要管理员协助");
    expect(treeText(card)).not.toContain("按原参数重试");
    const footer = card.props.children[1];
    expect(footer.props.children.props.disabled).toBe(!canRecover);
});
