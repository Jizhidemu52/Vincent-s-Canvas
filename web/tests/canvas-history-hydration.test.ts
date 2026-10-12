import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { restoreAgentMediaWorkflow } from "@/lib/canvas/agent-media-workflow";
import { CanvasNodeType, type CanvasAssistantSession, type CanvasNodeData } from "@/types/canvas";

// Run the exact page-owned helpers with only the media-storage boundary stubbed.
const source = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("project.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set([
    "createCanvasHydrationContext", "memoCanvasHydration", "mapCanvasHydration", "uploadCanvasHydrationImage",
    "sameCanvasHydrationValue", "boundedCanvasHistory", "hydrateCanvasHistory", "hydrateCanvasImages", "hydrateAssistantImages", "hasPendingImageTask", "resetInterruptedGeneration", "imageMetadata",
    "INTERRUPTED_IMAGE_TASK_ERROR",
]);
const code = ts.transpileModule(ast.statements.filter(statement => (ts.isFunctionDeclaration(statement) && names.has(statement.name?.text || ""))
    || (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => names.has(declaration.name.getText(ast)))))
    .map(statement => statement.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
}).outputText;

function helpers(uploadImage: (content: string) => Promise<unknown>) {
    const exports: any = {};
    new Function("exports", "CanvasNodeType", "restoreAgentMediaWorkflow", "uploadImage", `${code}\nObject.assign(exports, { ${[...names].join(", ")} });`)(exports, CanvasNodeType, restoreAgentMediaWorkflow, uploadImage);
    return exports;
}

const noUpload = async () => { throw new Error("Unexpected media upload"); };
const node = (content = "blob:current"): CanvasNodeData => ({ id: "image", type: CanvasNodeType.Image, title: "original", position: { x: 0, y: 0 }, width: 100, height: 80, metadata: { storageKey: "image:original", content, status: "success" } });
const frame = (nodes: CanvasNodeData[], chatSessions: CanvasAssistantSession[] = []) => ({ nodes, connections: [], chatSessions, activeChatId: null, backgroundMode: "dots", showImageInfo: false });

test("unchanged current graph and fifty history frames retain node/chat references", async () => {
    const io = helpers(noUpload);
    const context = io.createCanvasHydrationContext();
    const nodes = [node()];
    const sessions: CanvasAssistantSession[] = [{ id: "chat", title: "Original", createdAt: "before", updatedAt: "now", messages: [{ id: "m", role: "user", text: "Original" }] }];
    const original = frame(nodes, sessions);
    expect(io.resetInterruptedGeneration(nodes, context)).toBe(nodes);
    expect(await io.hydrateCanvasImages(nodes, context)).toBe(nodes);
    expect(await io.hydrateAssistantImages(sessions, nodes, context)).toBe(sessions);
    const history = await io.hydrateCanvasHistory({ past: Array(50).fill(original), future: [original] }, context);
    for (const restored of [...history.past, ...history.future]) {
        expect(restored).toBe(original);
        expect(restored.nodes).toBe(nodes);
        expect(restored.chatSessions).toBe(sessions);
        expect(restored.chatSessions[0].messages[0].references).toBeUndefined();
    }
});

test("inline media is imported once per restore lifecycle across shared nodes and chat references", async () => {
    const uploads: string[] = [];
    const io = helpers(async content => { uploads.push(content); return { url: "blob:restored", storageKey: "image:restored", width: 100, height: 80, bytes: 4, mimeType: "image/png" }; });
    const context = io.createCanvasHydrationContext();
    const originalNode = node("data:image/png;base64,ORIGINAL");
    delete originalNode.metadata!.storageKey;
    const nodes = [originalNode];
    const sessions: CanvasAssistantSession[] = [{ id: "chat", title: "Original", createdAt: "before", updatedAt: "now", messages: [{ id: "m", role: "user", text: "Original", references: [{ id: "ref", type: CanvasNodeType.Image, title: "Exact bytes", dataUrl: originalNode.metadata!.content }] }] }];
    const current = await io.hydrateCanvasImages(nodes, context);
    const currentSessions = await io.hydrateAssistantImages(sessions, current, context);
    const history = await io.hydrateCanvasHistory({ past: Array.from({ length: 50 }, (_, index) => frame(index ? nodes : [{ ...originalNode, position: { x: -10, y: -20 } }], sessions)), future: [] }, context);
    expect(uploads).toEqual(["data:image/png;base64,ORIGINAL"]);
    expect(current[0].metadata.content).toBe("blob:restored");
    expect(currentSessions[0].messages[0].references[0].dataUrl).toBe("blob:restored");
    expect(history.past[1].nodes).toBe(current);
    expect(history.past[49].nodes[0]).toBe(current[0]);
    expect(history.past[0].nodes[0].position).toEqual({ x: -10, y: -20 });
    expect(history.past[49].chatSessions).toBe(currentSessions);
    expect(originalNode.metadata!.content).toBe("data:image/png;base64,ORIGINAL");
    expect(originalNode.metadata!.storageKey).toBeUndefined();
    await io.hydrateCanvasImages(nodes, io.createCanvasHydrationContext());
    expect(uploads).toHaveLength(2);
});

test("interrupted generation is reset once per shared node without mutating source or dropping recovery ID", () => {
    const io = helpers(noUpload);
    const context = io.createCanvasHydrationContext();
    const loading: CanvasNodeData = { ...node(), type: CanvasNodeType.Video, metadata: { status: "loading", videoTaskId: "recover-original" } };
    const nodes = [loading, node()];
    const a = io.resetInterruptedGeneration(nodes, context);
    const b = io.resetInterruptedGeneration([loading, nodes[1]], context);
    expect(a[0]).toBe(b[0]);
    expect(a[1]).toBe(nodes[1]);
    expect(a[0].metadata.status).toBe("error");
    expect(a[0].metadata.videoTaskId).toBe("recover-original");
    expect(a[0].metadata.errorDetails).toContain("不会重新生成");
    expect(loading.metadata!.status).toBe("loading");
});

test("interrupted image bindings survive current and history hydration as recoverable errors", async () => {
    const io = helpers(noUpload);
    const context = io.createCanvasHydrationContext();
    const imageTask = { requestId: "stable-request:0", taskId: "accepted-task", ownerId: "employee-a", projectId: "project-a", resultIndex: 0 };
    const loading: CanvasNodeData = { ...node(), metadata: { status: "loading", imageTask, batchRootId: "batch-root" } };
    const root: CanvasNodeData = { ...node(), id: "batch-root", metadata: { status: "loading", isBatchRoot: true } };
    const nodes = [loading, root];
    const current = io.resetInterruptedGeneration(nodes, context);
    const history = await io.hydrateCanvasHistory({ past: [frame(nodes)], future: [frame(nodes)] }, context);
    for (const restored of [current[0], history.past[0].nodes[0], history.future[0].nodes[0]]) {
        expect(restored.metadata.imageTask).toEqual(imageTask);
        expect(restored.metadata.status).toBe("error");
        expect(restored.metadata.errorDetails).toContain("不会重新生成");
    }
    expect(loading.metadata!.status).toBe("loading");
    expect(current[0]).toBe(history.past[0].nodes[0]);
    expect(io.hasPendingImageTask(root, nodes)).toBeTruthy();
    for (const restored of [current[1], history.past[0].nodes[1], history.future[0].nodes[1]]) {
        expect(restored.metadata.status).toBe("error");
        expect(restored.metadata.errorDetails).toContain("恢复原图片任务");
    }
    expect(root.metadata!.status).toBe("loading");
});

test("workflow hydration follows each historical graph instead of reusing the current media URL", async () => {
    const io = helpers(noUpload);
    const context = io.createCanvasHydrationContext();
    const workflow = { id: "workflow", intent: "image" as const, prompt: "exact", imageModel: "model", videoModel: "video", imageCount: 1, videoSeconds: "6", aspectRatio: "1:1", referenceNodeIds: [], candidates: [{ nodeId: "image", status: "success" as const, url: "blob:current", storageKey: "image:original" }], imageStatus: "success" as const, videoStatus: "idle" as const };
    const sessions: CanvasAssistantSession[] = [{ id: "chat", title: "Original", createdAt: "before", updatedAt: "now", messages: [{ id: "m", role: "assistant", text: "Original", detail: { mediaWorkflow: workflow } }] }];
    const nodes = [node()];
    expect(await io.hydrateAssistantImages(sessions, nodes, context)).toBe(sessions);
    const history = await io.hydrateCanvasHistory({ past: [frame([node("blob:past")], sessions)], future: [frame([node("blob:future")], sessions)] }, context);
    expect(history.past[0].chatSessions[0].messages[0].detail.mediaWorkflow.candidates[0].url).toBe("blob:past");
    expect(history.future[0].chatSessions[0].messages[0].detail.mediaWorkflow.candidates[0].url).toBe("blob:future");
    expect(workflow.candidates[0].url).toBe("blob:current");
});

test("failed media restoration rejects and leaves original project/history available for fallback", async () => {
    const io = helpers(async () => { throw new Error("storage unavailable"); });
    const original = node("data:image/png;base64,EXACT");
    delete original.metadata!.storageKey;
    const history = { past: [frame([original])], future: [] };
    await expect(io.hydrateCanvasHistory(history)).rejects.toThrow("storage unavailable");
    expect(history.past[0].nodes[0]).toBe(original);
    expect(original.metadata!.content).toBe("data:image/png;base64,EXACT");
    expect(original.metadata!.storageKey).toBeUndefined();
});
