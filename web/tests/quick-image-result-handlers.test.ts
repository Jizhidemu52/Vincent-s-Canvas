import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = ts.createSourceFile("index.tsx", readFileSync(new URL("../src/pages/image/index.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlers = new Map<string, string>();
function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ["openResultEditor", "shareResultDesign", "saveResultToAssets"].includes(node.name.text)) handlers.set(node.name.text, node.initializer!.getText(source));
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "onPlaceCanvas" && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && ts.isConditionalExpression(node.initializer.expression)) handlers.set("place", node.initializer.expression.whenTrue.getText(source));
    ts.forEachChild(node, collect);
}
collect(source);

function execute(name: string, scope: Record<string, unknown>) {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Missing real page handler ${name}`);
    const code = ts.transpileModule(`return (${handler});`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;
    return new Function("scope", `const { ${Object.keys(scope).join(", ")} } = scope;\n${code}`)(scope);
}

for (const quickTool of [true, false]) test(`result actions ${quickTool ? "sanitize managed recipes" : "preserve ordinary provenance"} without changing media or source history`, async () => {
    const image = { id: "result", dataUrl: "blob:original-result", storageKey: "original-key", width: 256, height: 128, bytes: 1536, mimeType: "image/png", prompt: "private server recipe", sourceTaskId: "task-id", imageName: "result-image" };
    const log = { images: [image], prompt: "private server recipe", model: "private-server-model" };
    const before = structuredClone({ image, log });
    const actions: Record<string, any> = {};
    const scope = {
        quickTool, logs: [log], unclassifiedLogs: [], prompt: "ordinary draft", model: log.model, adminModelId: log.model,
        historyTool: "remove-background", toolMode: "remove-background", toolModeConfig: { title: "一键去背景", projectId: "tool-remove-background" }, operationType: "inpaint", user: { id: "owner" },
        resultEditorNode: (value: typeof image) => ({ metadata: { content: value.dataUrl, storageKey: value.storageKey } }),
        imageEditor: { open: (value: unknown) => { actions.edit = value; } },
        libraryShare: { share: async (value: unknown) => { actions.share = value; } },
        resultCanvas: { place: (value: unknown) => { actions.place = value; } },
        addAsset: (value: unknown) => { actions.asset = value; },
        uploadImage: async (url: string) => { expect(url).toBe(image.dataUrl); return { url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType }; },
        canvasImageDownloadFileName: () => "result.png", message: { success: () => {}, error: (value: unknown) => { throw new Error(String(value)); } },
        uiText: (value: string) => value, generationErrorMessage: (value: unknown) => String(value),
    };
    for (const name of ["openResultEditor", "shareResultDesign", "saveResultToAssets", "place"]) await execute(name, scope)(image, 0);
    expect(actions.edit.node.metadata).toEqual({ content: image.dataUrl, storageKey: image.storageKey });
    expect(actions.share).toMatchObject({ dataUrl: image.dataUrl, storageKey: image.storageKey });
    expect(actions.asset.data).toMatchObject({ dataUrl: image.dataUrl, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes });
    expect(actions.place).toMatchObject({ url: image.dataUrl, storageKey: image.storageKey, width: image.width, height: image.height });
    for (const value of [actions.edit, actions.share, actions.asset.metadata, actions.place]) {
        if (quickTool) { expect(value.prompt || "").toBe(""); expect(value.model || "").toBe(""); }
        else expect(value).toMatchObject({ prompt: image.prompt, model: log.model });
    }
    expect(actions.edit.sourceTaskId).toBe(quickTool ? undefined : image.sourceTaskId);
    expect(actions.place.sourceTaskId).toBe(quickTool ? undefined : image.sourceTaskId);
    if (quickTool) expect(JSON.stringify(actions)).not.toContain("private");
    expect({ image, log }).toEqual(before);
});
