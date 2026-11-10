import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createLatestVideoPreview, hydrateVideoLogMedia } from "@/pages/video/video-log-media";
import { hydrateImageLogMedia } from "@/pages/image/image-log-media";
import { refreshImageLogDuration } from "@/pages/image/image-log-duration";

const sources = new Map(["image", "video"].map(kind => [kind, ts.createSourceFile(`${kind}.tsx`, readFileSync(new URL(`../src/pages/${kind}/index.tsx`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)]));
function pageFunction(kind: "image" | "video", name: string, scope: Record<string, unknown>) {
    const source = sources.get(kind)!;
    let expression: ts.Expression | ts.FunctionDeclaration | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) expression = node.initializer;
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node;
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (!expression) throw new Error(`Missing ${kind} page function ${name}`);
    const code = ts.transpileModule(`const run = ${expression.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(scope), `${code}\nreturn run;`)(...Object.values(scope));
}

const task = {
    id: "paid-original", requestId: "paid-request", status: "success", resultUrls: [], failureReason: null,
    queuedAt: "2026-11-10T07:50:48.073Z", completedAt: "2026-11-10T07:59:32.825Z",
};

function historyHarness(kind: "image" | "video", read: (id: string) => Promise<any>) {
    const original = {
        id: "selected", status: "成功", ownerId: "owner", task: { id: task.id }, durationMs: 2124000,
        video: { id: "video", url: "blob:video", storageKey: "video:original", durationMs: 2124000, serverAssetId: "7075c394-1184-44cc-9077-068d78e8b36d" },
        images: [{ id: "image", dataUrl: "blob:image", storageKey: "image:original", sourceTaskId: task.id, durationMs: 2124000 }],
        references: [], videoReferences: [], audioReferences: [],
    };
    let owner = "owner", selected: any, results: any[] = [], logs = [original], unclassified: any[] = [], completion: Promise<void> | undefined;
    const writes: any[] = [], reads: string[] = [], warnings: string[] = [];
    const noop = () => {};
    const loader = createLatestVideoPreview();
    const scope = {
        running: false, pendingRestoreRevision: { current: 0 }, resultViewPinnedRef: { current: false }, previewRevision: { current: 0 },
        resultViewScopeRef: { current: 0 }, mountedRef: { current: true }, visibleResultLogIdsRef: { current: new Set() }, restoredInitialResultRef: { current: false },
        user: { id: "owner" }, useUserStore: { getState: () => ({ user: { id: owner } }) },
        setPreviewLog: (value: unknown) => { selected = value; }, setResults: (value: any[]) => { results = value; },
        setLogs: (update: (value: any[]) => any[]) => { logs = update(logs); },
        setUnclassifiedLogs: (update: (value: any[]) => any[]) => { unclassified = update(unclassified); },
        setLogsOpen: noop, setPreviewLoading: noop, setPreviewError: noop,
        hydrateVideoLogMedia, hydrateImageLogMedia, refreshImageLogDuration,
        resolveImageUrl: async (_key: string, url: string) => url,
        resolveMediaUrl: async (_key: string, url: string) => url,
        getQueuedTask: async (id: string) => { reads.push(id); return read(id); },
        logStore: { setItem: async (_id: string, value: unknown) => { writes.push(value); } },
        historyStore: { setItem: async (_id: string, value: unknown) => { writes.push(value); } },
        serializeLog: pageFunction(kind, "serializeLog", {}),
        logRefreshRevisionRef: { current: 0 }, logRefreshRevision: { current: 0 },
        upsertGenerationLog: (values: any[], value: any) => values.map(item => item.id === value.id ? value : item),
        uiText: (value: string) => value,
        message: { warning: (value: string) => warnings.push(value), error: (value: string) => warnings.push(value) },
        previewLoader: {
            load: (...args: Parameters<typeof loader.load>) => { completion = loader.load(...args); return completion; },
        },
    };
    const preview = pageFunction(kind, "previewGenerationLog", scope);
    return {
        original, scope, writes, reads, warnings,
        async open(log = original) { const returned = preview(log); await (kind === "video" ? completion : returned); },
        owner(value: string) { owner = value; },
        invalidate() { loader.invalidate(); scope.previewRevision.current += 1; },
        result: () => ({ selected, results, logs, unclassified }),
    };
}

test.each(["video", "image"] as const)("opening a saved %s record corrects only its original task timing and local history", async kind => {
    const h = historyHarness(kind, async () => task);
    await h.open();
    expect(h.reads).toEqual(["paid-original"]);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].durationMs).toBe(524752);
    expect(h.result().selected.durationMs).toBe(524752);
    expect(h.result().logs[0].durationMs).toBe(524752);
    expect(h.result().results[0][kind].durationMs).toBe(524752);
    expect(h.original.durationMs).toBe(2124000);
    expect(h.warnings).toEqual([]);
});

test.each(["video", "image"] as const)("a %s history lookup failure leaves the original successful result available without a fake correction", async kind => {
    const h = historyHarness(kind, async () => { throw new Error("offline"); });
    await h.open();
    expect(h.writes).toEqual([]);
    expect(h.result().results[0].status).toBe("success");
    expect(h.result().results[0][kind].durationMs).toBe(2124000);
    expect(h.warnings).toEqual([]);
});

test.each(["video", "image"] as const)("a %s history lookup cannot import timestamps from a different task ID", async kind => {
    const h = historyHarness(kind, async () => ({ ...task, id: "someone-else" }));
    await h.open();
    expect(h.writes).toEqual([]);
    expect(h.result().selected.durationMs).toBe(2124000);
});

for (const kind of ["video", "image"] as const) {
    test.each(["owner", "selection", "leaving"])(`${kind} history timing is fenced when %s changes during its GET`, async change => {
        const readStarted = Promise.withResolvers<void>(), gate = Promise.withResolvers<typeof task>();
        const h = historyHarness(kind, async () => { readStarted.resolve(); return gate.promise; });
        const pending = h.open();
        await readStarted.promise;
        if (change === "owner") h.owner("different-owner");
        else if (change === "selection") h.invalidate();
        else h.scope.mountedRef.current = false;
        gate.resolve(task);
        await pending;
        expect(h.writes).toEqual([]);
        expect(h.result().results).toEqual([]);
        expect(h.warnings).toEqual([]);
    });
}

test.each(["video", "image"] as const)("a verified %s task without completion time replaces an old guessed duration with unknown", async kind => {
    const h = historyHarness(kind, async () => ({ ...task, completedAt: null }));
    await h.open();
    expect(h.writes[0].durationMs).toBeNull();
    expect(h.result().selected.durationMs).toBeNull();
    expect(h.result().results[0][kind].durationMs).toBeNull();
});
