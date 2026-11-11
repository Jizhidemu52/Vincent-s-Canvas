import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { RefreshCw } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { generationErrorMessage, imageResultProcessingFailureMessage, isImageResultProcessingFailure, mergeGenerationDiagnostics } from "@/lib/generation-feedback";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { i18nHarness } from "./helpers/i18n-harness";

// Evaluate the actual private node card and diagnostic copy callback, with isolated hook/I/O boundaries.
function loadFunction(path: string, name: string, dependencies: Record<string, unknown>) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!declaration) throw new Error(`${name} not found`);
    const code = ts.transpileModule(`${declaration.getText(ast).replace(/^export\s+/, "")}; return ${name};`, {
        compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React },
    }).outputText;
    return new Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
}
function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement<any>(node)) return [];
    return [node, ...elements(node.props.children)];
}
const binding = { ownerId: "owner", projectId: "project", requestId: "request-original:0", taskId: "task-original", resultIndex: 0 };
const node: CanvasNodeData = { id: "white-cup", type: CanvasNodeType.Image, title: "白陶瓷杯 · 去背景", position: { x: 0, y: 0 }, width: 320, height: 320,
    metadata: { status: "error", errorDetails: "原任务结果待核查，请查询原任务或联系管理员；不要重复生成。", imageTask: binding, sourceTaskId: binding.taskId } };

function harness(patch: Partial<CanvasNodeData["metadata"]> = {}, options: { onReload?: () => void; type?: CanvasNodeType } = {}) {
    const copies: string[] = [], retries: string[] = [];
    const Button = ({ children, href, onClick }: { children: React.ReactNode; href?: string; onClick?: () => void }) => href ? <a href={href}>{children}</a> : <button type="button" onClick={onClick}>{children}</button>;
    const Diagnostic = loadFunction("../src/components/generation-diagnostic.tsx", "GenerationDiagnostic", { React, Button, ...i18nHarness, generationErrorMessage, isImageResultProcessingFailure, mergeGenerationDiagnostics,
        useCopyText: () => (value: string) => { copies.push(value); return Promise.resolve(true); } });
    const ErrorContent = loadFunction("../src/components/canvas/canvas-node.tsx", "ErrorContent", { React, RefreshCw, ...i18nHarness, CanvasNodeType, GenerationDiagnostic: Diagnostic,
        imageResultProcessingFailureMessage, isImageResultProcessingFailure, mergeGenerationDiagnostics });
    const current = { ...node, type: options.type ?? node.type, metadata: { ...node.metadata, ...patch } };
    const tree = ErrorContent({ node: current, theme: canvasThemes.light, onRetry: (value: CanvasNodeData) => retries.push(value.id), onReload: options.onReload });
    const card = elements(tree).find(element => element.type === Diagnostic);
    const copy = async () => {
        if (!card) throw new Error("Diagnostic missing");
        const button = elements(Diagnostic(card.props)).find(element => element.type === Button && element.props.onClick)!;
        await button.props.onClick();
    };
    return { html: renderToStaticMarkup(tree), tree, card, copies, retries, copy };
}

test("latest ordinary canvas uncertainty card copies persisted task and exact request IDs once", async () => {
    const h = harness();
    expect(h.html).toContain("恢复查询");
    await h.copy();
    expect(h.copies[0]).toContain("原任务结果待核查");
    expect(h.copies[0]?.match(/^taskId: task-original$/gm)).toHaveLength(1);
    expect(h.copies[0]?.match(/^requestId: request-original:0$/gm)).toHaveLength(1);
});

test.each(["marker", "message"])("postprocess %s hides retry/resume and exposes original assets with diagnostic IDs", async source => {
    const h = harness(source === "marker" ? { imageTask: { ...binding, postprocessFailed: true } } : { errorDetails: imageResultProcessingFailureMessage });
    expect(h.html).toContain("图片后处理未完成");
    expect(h.html).toContain("查看素材库原件");
    expect(h.html).toContain('href="/assets"');
    expect(h.html).not.toMatch(/恢复查询|>重试<|暂时无法获取进度/);
    expect(elements(h.tree).filter(element => element.type === "button")).toHaveLength(0);
    await h.copy();
    expect(h.copies[0]).toContain("taskId: task-original");
    expect(h.copies[0]).toContain("requestId: request-original:0");
});

test("request-only submission still has a copyable request ID", async () => {
    const h = harness({ imageTask: { ...binding, taskId: undefined }, sourceTaskId: undefined });
    await h.copy();
    expect(h.copies[0]).toContain("requestId: request-original:0");
    expect(h.copies[0]).not.toContain("taskId:");
});

test("terminal cards retain sourceTaskId after the pending binding is cleared", async () => {
    const h = harness({ imageTask: undefined, errorDetails: "任务已取消" });
    await h.copy();
    expect(h.copies[0]).toContain("taskId: task-original");
    expect(h.html).not.toContain("恢复查询");
    expect(h.html).toContain("重试");
});

test("genuine pause keeps existing same-task callback and stops event propagation", () => {
    const h = harness({ errorDetails: "上游任务已暂停，可查询原任务" });
    const retry = elements(h.tree).find(element => element.type === "button")!;
    let stopped = false;
    retry.props.onClick({ stopPropagation() { stopped = true; } });
    expect(h.retries).toEqual([node.id]); expect(stopped).toBe(true);
    expect(h.html).not.toContain("查看素材库原件");
});

test("image reload remains available independently of a stale result marker", () => {
    let reloaded = 0;
    const h = harness({ imageTask: { ...binding, postprocessFailed: true } }, { onReload: () => { reloaded++; } });
    expect(h.html).toContain("重新加载");
    const reload = elements(h.tree).find(element => element.type === "button")!;
    reload.props.onClick({ stopPropagation() {} });
    expect(reloaded).toBe(1); expect(h.retries).toEqual([]);
});

test("media diagnostics use their existing request/task bindings too", async () => {
    const h = harness({ imageTask: undefined, sourceTaskId: undefined, mediaTask: { ...binding, requestId: "media-request", taskId: "media-task" }, videoTaskId: "media-task" }, { type: CanvasNodeType.Video });
    await h.copy();
    expect(h.copies[0]?.match(/^taskId: media-task$/gm)).toHaveLength(1);
    expect(h.copies[0]).toContain("requestId: media-request");
    expect(h.html).toContain("恢复查询");
});
