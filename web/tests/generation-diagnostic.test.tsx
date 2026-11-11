import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "antd";
import ts from "typescript";
import { GenerationDiagnostic } from "../src/components/generation-diagnostic";
import { imageResultProcessingFailureMessage, isImageResultProcessingFailure, mergeGenerationDiagnostics } from "../src/lib/generation-feedback";
import { uiText, useUiText } from "../src/lib/i18n";

// Render the actual private result card so its recovery buttons stay covered.
const source = readFileSync(new URL("../src/pages/image/index.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("image.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const card = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "FailedImageCard");
if (!card) throw new Error("FailedImageCard was not found");
const code = ts.transpileModule(`${card.getText(ast)}; return FailedImageCard;`, { compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React } }).outputText;
const FailedImageCard = new Function("React", "Button", "GenerationDiagnostic", "GenerationTaskCancel", "uiText", "useUiText", "isImageResultProcessingFailure", "mergeGenerationDiagnostics", code)(
    React, Button, GenerationDiagnostic, () => <span>取消原任务</span>, uiText, useUiText, isImageResultProcessingFailure, mergeGenerationDiagnostics,
) as React.ComponentType<{ error: string; diagnostic?: string; taskId?: string; requestId?: string; recovery?: { recovery: "resume" | "investigate"; stopped?: boolean }; onRetry: () => void }>;

test.each([undefined, "resume", "investigate"] as const)("postprocessing failure exposes saved originals and never offers resubmission/recovery: %s", recovery => {
    const html = renderToStaticMarkup(<FailedImageCard error={imageResultProcessingFailureMessage} diagnostic="code: IMAGE_RESULT_PROCESSING_FAILED" recovery={recovery ? { recovery } : undefined} taskId="original-task" requestId="original-request" onRetry={() => { throw new Error("must not retry"); }} />);
    expect(html).toContain("图片后处理失败");
    expect(html).toContain("查看素材库原件");
    expect(html).toContain('href="/assets"');
    expect(html).toContain("复制诊断信息");
    expect(html).not.toMatch(/继续获取结果|刷新进度|按原参数重试|取消原任务|暂时无法获取进度/);
});

test("a genuine upstream pause keeps its original-task recovery control", () => {
    const html = renderToStaticMarkup(<FailedImageCard error="原任务的上游查询已暂停" recovery={{ recovery: "resume" }} onRetry={() => {}} />);
    expect(html).toContain("继续获取结果");
    expect(html).not.toContain("查看素材库原件");
});

test("ordinary terminal errors keep explicit retry and do not claim any original was saved", () => {
    const html = renderToStaticMarkup(<FailedImageCard error="内容未通过审核" onRetry={() => {}} />);
    expect(html).toContain("按原参数重试");
    expect(html).not.toContain("查看素材库原件");
});
