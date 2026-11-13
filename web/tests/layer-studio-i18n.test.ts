import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import layerEnglish from "../src/lib/i18n/en-layer-studio";
import { setUiLocale, uiText } from "../src/lib/i18n";
import { layerStudioUiMessage } from "../src/pages/layer-studio/page-copy";
import { layerStudioSubmission, newLayerStudioWorkspace } from "../src/pages/layer-studio/page-state";
import { createLayerStudioEditDocument } from "../src/pages/layer-studio/layer-composition";

afterEach(async () => { await setUiLocale("zh-CN"); });

test("layer UI dictionary preserves placeholders and has no untranslated Chinese values", () => {
    const parameters = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    for (const [source, value] of Object.entries(layerEnglish)) {
        expect(value.trim().length, source).toBeGreaterThan(0);
        expect(value, source).not.toMatch(/\p{Script=Han}/u);
        expect(parameters(value), source).toEqual(parameters(source));
    }
    for (const name of ["index.tsx", "layer-editor.tsx", "page-copy.ts"]) {
        const file = readFileSync(new URL(`../src/pages/layer-studio/${name}`, import.meta.url), "utf8");
        const ast = ts.createSourceFile(name, file, ts.ScriptTarget.Latest, true, name.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) && ["t", "uiText"].includes(node.expression.getText(ast)) && ts.isStringLiteral(node.arguments[0]) && /\p{Script=Han}/u.test(node.arguments[0].text)) {
                expect(layerEnglish[node.arguments[0].text], node.arguments[0].text).toBeDefined();
            }
            if (ts.isJsxText(node)) expect(node.text).not.toMatch(/\p{Script=Han}/u);
            ts.forEachChild(node, visit);
        };
        visit(ast);
    }
});

test("English system messages retain dynamic values and Chinese mode returns identical originals", async () => {
    const messages = [
        "当前模式最多添加 10 张参考图，未上传本批文件。",
        "图层原件读取失败（403），当前编辑已保留",
        "功能配置尚未就绪，暂不能创建新任务；已有结果仍可编辑和下载。",
        "上次提交待核查；保留原请求编号，只查询原任务。",
        "图层拆分必须恰好提供 1 张参考图",
    ];
    for (const message of messages) expect(layerStudioUiMessage(message)).toBe(message);
    await setUiLocale("en-US");
    for (const message of messages) expect(layerStudioUiMessage(message)).not.toMatch(/\p{Script=Han}/u);
    expect(layerStudioUiMessage(messages[0])).toContain("10");
    expect(layerStudioUiMessage(messages[1])).toContain("403");
    expect(uiText("已保存 {saved} / {total} 份原件", { saved: 2, total: 3 })).toBe("Saved 2 / 3 originals");
    await setUiLocale("zh-CN");
    for (const [source] of Object.entries(layerEnglish)) expect(uiText(source)).toBe(source);
    for (const message of messages) expect(layerStudioUiMessage(message)).toBe(message);
});

test("language switches do not rewrite source prompts, reference identity, task parameters or OCR geometry", async () => {
    const workspace = newLayerStudioWorkspace("owner-a", "workspace-a");
    workspace.form.mode = "generate";
    workspace.form.prompt = "保留针织纹理、中文绣花和颜色";
    workspace.references = [{ id: "source-one", name: "原始毛衫.png", bytes: 123, mimeType: "image/png", sha256: "a".repeat(64), previewable: true }];
    const original = JSON.stringify(workspace);
    const before = layerStudioSubmission(workspace, "original-request-id");
    const result = { version: 1 as const, taskId: "original-task-id", mode: "decompose" as const, status: "ready" as const, expectedOutputCount: 1,
        items: [{ index: 0, groupIndex: 0, urlIndex: 0, role: "base" as const, state: "saved" as const, width: 256, height: 256, name: "中文图层", description: "保持原图", textRecognition: { text: "针织文字" } }] };
    const resultBefore = JSON.stringify(result);
    const editBefore = createLayerStudioEditDocument(result);
    await setUiLocale("en-US");
    expect(layerStudioSubmission(workspace, "original-request-id")).toEqual(before);
    expect(createLayerStudioEditDocument(result)).toEqual(editBefore);
    expect(JSON.stringify(workspace)).toBe(original);
    expect(JSON.stringify(result)).toBe(resultBefore);
    await setUiLocale("zh-CN");
    expect(layerStudioSubmission(workspace, "original-request-id")).toEqual(before);
});
