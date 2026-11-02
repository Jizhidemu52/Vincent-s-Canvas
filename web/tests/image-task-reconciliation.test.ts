import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { findPendingImageTask, updateImageResultForRecord, type PendingImage } from "../src/pages/image/image-pending";
import { classifyTaskRecovery, submissionInvestigationMessage } from "../src/services/api/task-result-reconciliation";
import { generationErrorDiagnostic } from "../src/lib/generation-feedback";
import { defaultConfig } from "../src/stores/use-config-store";
import type { QueuedTask } from "../src/services/api/generation-tasks";

// Execute the actual page callbacks, not a duplicate implementation of them.
const source = readFileSync(new URL("../src/pages/image/index.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("image.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["finishImage", "reconcilePendingImage", "stopPendingQueries"];
const functions = new Map<string, string>();
const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text) && node.initializer) functions.set(node.name.text, node.initializer.getText(ast));
    ts.forEachChild(node, visit);
};
visit(ast);
if (functions.size !== names.length) throw new Error("The image reconciliation callbacks were not found");
const code = ts.transpileModule(`${names.map(name => `const ${name} = ${functions.get(name)};`).join("\n")} exports.reconcile = reconcilePendingImage; exports.stop = stopPendingQueries;`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

const pending: PendingImage = { id: "record-a", ownerId: "employee-a", tool: "image-edit", createdAt: 1, requestId: "request-a", taskId: "task-a", snapshot: { text: "original", config: { ...defaultConfig, model: "disabled-old-provider-model" }, references: [] } };
const task: QueuedTask = { id: "task-a", requestId: "request-a:0", status: "success", resultUrls: ["/api/assets/result-a/content"], failureReason: null };

function harness(options: { task?: QueuedTask | null; results?: any[]; records?: PendingImage[]; commits?: Map<string, { stopped: boolean; promise?: Promise<unknown> }>; upload?: (url: string) => Promise<void>; afterRemove?: (record: PendingImage) => void } = {}) {
    let currentTask = options.task === undefined ? task : options.task;
    let owner = pending.ownerId;
    let results = options.results || [{ id: pending.id, status: "paused", recovery: pending }];
    const records = new Map((options.records || [pending]).map(record => [record.id, { ...record }]));
    const calls: string[] = [], logs: any[] = [], uploads: string[] = [];
    const bindings = {
        removedPendingIds: { current: new Set<string>() }, manuallyStoppedIds: { current: new Set<string>() },
        observationStopRequested: { current: false }, observationControllers: { current: new Set<AbortController>() },
        mountedRef: { current: true }, activeSubmissionRef: { current: false }, finishingImages: { current: options.commits || new Map() },
        latestPendingImages: { current: [...records.values()] },
        useUserStore: { getState: () => ({ user: { id: owner } }) },
        findPendingImageTask, updateImageResultForRecord, classifyTaskRecovery, submissionInvestigationMessage, generationErrorDiagnostic,
        async getQueuedTask(id: string, signal: AbortSignal) { signal.throwIfAborted(); calls.push(`GET ${id}`); return currentTask; },
        async getQueuedTaskByRequestId(id: string, signal: AbortSignal) { signal.throwIfAborted(); calls.push(`GET request:${id}`); return currentTask; },
        async uploadImage(url: string) { uploads.push(url); await options.upload?.(url); return { url, storageKey: `stored:${url}`, width: 100, height: 100, bytes: 123, mimeType: "image/png" }; },
        canvasImageReferenceIdentity: () => ({}), buildLog: (value: unknown) => value,
        async saveLog(log: unknown, preserveView: boolean, assertCurrent: () => void) { assertCurrent(); expect(preserveView).toBe(true); logs.push(log); },
        async persistPending(record: PendingImage) { records.set(record.id, record); bindings.latestPendingImages.current = [...records.values()]; },
        async removePending(record: PendingImage) { records.delete(record.id); bindings.removedPendingIds.current.add(record.id); bindings.latestPendingImages.current = [...records.values()]; options.afterRemove?.(record); },
        setResults(update: (value: any[]) => any[]) { results = update(results); },
        setPendingImages(value: PendingImage[]) { bindings.latestPendingImages.current = value; },
        message: { warning() {} },
    };
    const exports = {} as { reconcile: (record: PendingImage, signal: AbortSignal) => Promise<void>; stop: () => void };
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exports);
    return { ...exports, bindings, records, calls, logs, uploads, results: () => results, show: (value: any[]) => { results = value; }, server: (value: QueuedTask | null) => { currentTask = value; }, owner: (value: string) => { owner = value; } };
}

test("an already successful original task is imported once without using current model configuration", async () => {
    const h = harness(); const controller = new AbortController();
    await h.reconcile(pending, controller.signal);
    await h.reconcile(pending, controller.signal);
    expect(h.calls).toEqual(["GET task-a"]);
    expect(h.logs).toHaveLength(1); expect(h.uploads).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ id: pending.id, model: "disabled-old-provider-model" });
    expect(h.results()[0]).toMatchObject({ id: pending.id, status: "success", image: { sourceTaskId: task.id } });
    expect(h.records.size).toBe(0);
});

test.each([
    { status: "processing", recovery: "observe" },
    { status: "paused", upstreamTaskId: "upstream-original", recovery: "resume" },
    { status: "paused", upstreamTaskId: null, recovery: "investigate" },
])("%j is checked read-only and a later success fills its original record", async state => {
    const h = harness({ task: { ...task, ...state, resultUrls: [] } });
    const signal = new AbortController().signal;
    await h.reconcile(pending, signal);
    expect(h.records.get(pending.id)?.recovery).toBe(state.recovery);
    expect(h.uploads).toEqual([]);
    if (state.recovery === "investigate") expect(h.results()[0].error).toContain("暂无法恢复上游查询");
    h.server(task);
    await h.reconcile(h.records.get(pending.id)!, signal);
    expect(h.calls).toEqual(["GET task-a", "GET task-a"]);
    expect(h.logs).toHaveLength(1); expect(h.records.size).toBe(0);
});

test.each(["history", "new-task"])("a late result is saved but does not replace the current %s view", async kind => {
    const view = [{ id: kind, status: kind === "history" ? "success" : "pending", image: { id: "do-not-replace" } }];
    const h = harness({ results: view });
    await h.reconcile(pending, new AbortController().signal);
    expect(h.logs).toHaveLength(1); expect(h.results()).toEqual(view);
});

test.each(["account-change", "manual-stop"])("%s during image import prevents a late record write", async reason => {
    const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const h = harness({ upload: async () => { started.resolve(); await gate.promise; } });
    const promise = h.reconcile(pending, new AbortController().signal);
    await started.promise;
    if (reason === "account-change") h.owner("employee-b");
    else h.stop();
    gate.resolve(); await promise;
    expect(h.logs).toEqual([]); expect(h.records.has(pending.id)).toBe(true);
    expect(h.results()[0].status).toBe("paused");
    if (reason === "manual-stop") expect(h.records.get(pending.id)?.stopped).toBe(true);
});

test("leaving during confirmed image import still archives the original result without updating the disposed view", async () => {
    const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const h = harness({ upload: async () => { started.resolve(); await gate.promise; } });
    const controller = new AbortController();
    const promise = h.reconcile(pending, controller.signal);
    await started.promise;
    h.bindings.mountedRef.current = false;
    controller.abort();
    gate.resolve(); await promise;
    expect(h.logs).toHaveLength(1); expect(h.records.has(pending.id)).toBe(false);
    expect(h.results()[0].status).toBe("paused");
});

test.each([false, true])("a remounted workspace shares the original import and respects its explicit stop: %s", async stop => {
    const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const commits = new Map<string, { stopped: boolean; promise?: Promise<unknown> }>();
    const original = harness({ commits, upload: async () => { started.resolve(); await gate.promise; } });
    const first = original.reconcile(pending, new AbortController().signal);
    await started.promise;
    original.bindings.mountedRef.current = false;
    const remounted = harness({ commits });
    const second = remounted.reconcile(pending, new AbortController().signal);
    await Promise.resolve(); await Promise.resolve();
    if (stop) remounted.stop();
    gate.resolve(); await Promise.all([first, second]);
    expect(original.uploads).toHaveLength(1); expect(remounted.uploads).toEqual([]);
    expect(original.logs).toHaveLength(stop ? 0 : 1); expect(remounted.logs).toEqual([]);
    if (stop) expect(remounted.records.get(pending.id)?.stopped).toBe(true);
    expect(commits.size).toBe(0);
});

test("parallel completion uses independent import lifetimes when one record rebuilds the shared watch", async () => {
    const watch = new AbortController(), slow = Promise.withResolvers<void>(), slowStarted = Promise.withResolvers<void>();
    const other = { ...pending, id: "record-b", requestId: "request-b", taskId: "task-b" };
    const h = harness({ records: [pending, other], results: [{ id: pending.id, status: "paused" }, { id: other.id, status: "paused" }],
        upload: async url => { if (url.includes("result-b")) { slowStarted.resolve(); await slow.promise; } else await slowStarted.promise; },
        afterRemove: record => { if (record.id === pending.id) watch.abort(); },
    });
    // Each async GET captures its server snapshot before the second read starts.
    const first = h.reconcile(pending, watch.signal);
    h.server({ ...task, id: other.taskId, requestId: `${other.requestId}:0`, resultUrls: ["/api/assets/result-b/content"] });
    const second = h.reconcile(other, watch.signal);
    await slowStarted.promise;
    await first; expect(watch.signal.aborted).toBe(true);
    slow.resolve(); await second;
    expect(h.logs).toHaveLength(2); expect(h.uploads).toHaveLength(2); expect(h.records.size).toBe(0);
    expect(h.results().map(item => item.status)).toEqual(["success", "success"]);
});

test("duplicate notifications during import share the same result commit", async () => {
    const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
    const h = harness({ upload: async () => { started.resolve(); await gate.promise; } });
    const first = h.reconcile(pending, new AbortController().signal);
    await started.promise;
    const second = h.reconcile(pending, new AbortController().signal);
    await Promise.resolve(); gate.resolve(); await Promise.all([first, second]);
    expect(h.uploads).toHaveLength(1); expect(h.logs).toHaveLength(1);
});

test("wrong task identity never imports a result or deletes the pending record", async () => {
    const h = harness({ task: { ...task, requestId: "another-request:0" } });
    await h.reconcile(pending, new AbortController().signal);
    expect(h.uploads).toEqual([]); expect(h.records.has(pending.id)).toBe(true);
    expect(h.results()[0].error).toContain("标识不匹配");
});
