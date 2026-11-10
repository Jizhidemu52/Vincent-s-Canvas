import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import ts from "typescript";
import { completedTaskDurationMs } from "@/lib/completed-task-duration";
import { formatDuration } from "@/lib/image-utils";
import { defaultConfig } from "@/stores/use-config-store";
import { snapshotImageRequest, updateImageResultForRecord } from "@/pages/image/image-pending";

const source = ts.createSourceFile("image.tsx", readFileSync(new URL("../src/pages/image/index.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function pageFunction(name: string, scope: Record<string, unknown>) {
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

async function finishImageThroughPage(origin: "new" | "resume", durationMs: number | null) {
    const logs: any[] = [];
    const noop = () => {};
    const snapshot = { text: "original prompt", config: defaultConfig, references: [] };
    const pending = { id: "original-record", ownerId: "owner", requestId: "original-request", taskId: "original-task", tool: "image-edit", createdAt: 1, snapshot };
    const task = { id: pending.taskId, status: "success", resultUrls: ["/api/assets/original/content"], queuedAt: "2026-11-10T07:50:48.073Z", completedAt: durationMs === null ? null : "2026-11-10T07:59:32.825Z" };
    const scope = {
        finishingImages: { current: new Map() }, manuallyStoppedIds: { current: new Set() }, observationStopRequested: { current: false },
        observationControllers: { current: new Set() }, activeSubmissionRef: { current: false }, mountedRef: { current: true },
        pendingRestoreRevision: { current: 0 }, resultViewPinnedRef: { current: false }, inputDraftScope: "draft",
        user: { id: "owner" }, useUserStore: { getState: () => ({ user: { id: "owner" } }) },
        uploadImage: async (url: string) => ({ url, storageKey: "stored:original", width: 100, height: 100, bytes: 123, mimeType: "image/png" }),
        canvasImageReferenceIdentity: () => ({}), buildLog: (value: unknown) => value,
        saveLog: async (value: unknown) => { logs.push(value); },
        removePending: async () => {}, persistPending: async () => {},
        setResults: noop, setRunning: noop, setStartedAt: noop, setActiveTaskId: noop, setOptimizingPrompt: noop,
        workbenchSubmissions: { acquire: () => noop },
        findPendingImageTask: async () => task,
        completedTaskDurationMs, snapshotImageRequest, updateImageResultForRecord,
        nanoid: () => "original-record", historyTool: "image-edit", workspaceId: "workspace", operationType: "image_generation", businessModels: [],
        imageModelProfile: () => ({ kind: "openai" }), modelOptionName: (value: string) => value,
        requestGeneration: async (_config: unknown, _text: unknown, options: any) => {
            await options.onSubmissionStarted();
            await options.onSubmitted([pending.taskId]);
            return [{ id: "image", dataUrl: task.resultUrls[0], sourceTaskId: task.id, durationMs }];
        },
    };
    const finishImage = pageFunction("finishImage", scope);
    if (origin === "new") await pageFunction("runGenerationSlot", { ...scope, finishImage })(0, snapshot);
    else await pageFunction("resumePendingImages", { ...scope, finishImage })([pending]);
    return logs.at(-1);
}

test.each(["new", "resume"] as const)("%s image completion preserves server duration, excluding late browser imports", async origin => {
    const log = await finishImageThroughPage(origin, 524752);
    expect(log.status).toBe("成功");
    expect(log.durationMs).toBe(524752);
    expect(log.images[0].durationMs).toBe(524752);
});

test.each(["new", "resume"] as const)("%s image completion without trustworthy timing stores unknown rather than elapsed observation", async origin => {
    const log = await finishImageThroughPage(origin, null);
    expect(log.status).toBe("成功");
    expect(log.durationMs).toBeNull();
    expect(log.images[0].durationMs).toBeNull();
});

function treeText(node: unknown): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(treeText).join("");
    return React.isValidElement<{ children?: unknown }>(node) ? treeText(node.props.children) : "";
}

test.each([null, undefined, NaN, Infinity, -1])("image history keeps unknown timing visible: %s", durationMs => {
    const log = pageFunction("normalizeLog", { normalizeLogConfig: () => ({}) })({ id: "record", createdAt: 1, status: "成功", durationMs });
    expect(log.durationMs).toBeNull();
    const card = pageFunction("LogCard", {
        React, useUiText() {}, uiText: (value: string) => value, formatDuration,
        Tag: "tag", Checkbox: "input", formatBeijingDateTime: () => "time",
    })({ log, active: false, onClick() {} });
    expect(treeText(card)).toContain("耗时未知");
});

test("a genuinely measured zero image duration remains distinct from unknown", () => {
    const log = pageFunction("normalizeLog", { normalizeLogConfig: () => ({}) })({ id: "record", durationMs: 0 });
    expect(log.durationMs).toBe(0);
});

test.each([
    { recovery: "investigate", title: "需要管理员协助", action: "刷新进度" },
    { recovery: "resume", title: "暂时无法获取进度", action: "继续获取结果" },
    { recovery: "observe", title: "暂时无法获取进度", action: "刷新进度" },
])("the image recovery state %s never offers a new paid retry", state => {
    const card = pageFunction("FailedImageCard", {
        React, useUiText() {}, uiText: (value: string) => value,
        Button: "button", GenerationDiagnostic: "diagnostic", GenerationTaskCancel: "cancel",
    })({ error: "detail", recovery: { recovery: state.recovery }, onRetry() {} });
    expect(treeText(card)).toContain(state.title);
    expect(treeText(card)).toContain(state.action);
    expect(treeText(card)).not.toContain("按原参数重试");
});
