import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { validate, version } from "uuid";
import { createClientUuid } from "../src/lib/client-uuid";

test("browser product code uses the HTTP-compatible UUID and hashing implementations", () => {
    const root = fileURLToPath(new URL("../src/", import.meta.url));
    const violations: string[] = [];
    const visit = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const file = join(directory, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)) {
                const source = readFileSync(file, "utf8");
                if (/\bcrypto\s*\.\s*randomUUID\s*\(|\bcrypto\s*\.\s*subtle\s*\.\s*digest\s*\(/.test(source)) violations.push(relative(root, file));
            }
        }
    };
    visit(root);
    expect(violations).toEqual([]);
});

test("recolor saves retain a UUID across failed retries on HTTP and change it only for a new operation", async () => {
    const source = readFileSync(new URL("../src/pages/creative/recolor-dialog.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("recolor-dialog.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let saveInitializer: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "save") saveInitializer = node.initializer;
        ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!saveInitializer) throw new Error("RecolorDialog save handler was not found");
    const code = ts.transpileModule(`exports.save = ${saveInitializer.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    const httpCrypto = { getRandomValues: crypto.getRandomValues.bind(crypto) };
    const saves: Array<{ blob: Blob; description: string; clientOperationId: string }> = [];
    const errors: string[] = [];
    const rules = [{ from: "#112233", to: "#AABBCC" }];
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    const operation = { current: null as { identity: string; id: string } | null };
    const bindings = {
        crypto: httpCrypto,
        createClientUuid: () => createClientUuid(httpCrypto),
        original: { current: { width: 1, height: 1, data: new Uint8ClampedArray([17, 34, 51, 255]) } },
        source: { id: "original-image" }, operation, rules, tolerance: 8, busy: false,
        saveController: { current: null as AbortController | null }, previewController: { current: null as AbortController | null },
        processImageInWorker: async () => ({ changedPixels: 1 }),
        pixelsCanvas: (value: unknown) => value,
        editorPngBlob: async () => blob,
        setPreviewBusy() {}, setBusy() {}, setError() {},
        setSaveError: (value: string) => { if (value) errors.push(value); },
        uiText: (value: string) => value,
        onClose() {},
        onSave: async (output: Blob, description: string, save: { clientOperationId: string }) => {
            saves.push({ blob: output, description, clientOperationId: save.clientOperationId });
            if (saves.length === 1) throw new Error("fixture save failed");
        },
    };
    const exported = {} as { save: () => Promise<void> };
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exported);
    await exported.save();
    expect(errors).toEqual(["fixture save failed"]);
    await exported.save();
    expect(saves).toHaveLength(2);
    expect(validate(saves[0]!.clientOperationId)).toBe(true);
    expect(version(saves[0]!.clientOperationId)).toBe(4);
    expect(saves[1]).toEqual(saves[0]);
    expect(saves[1]!.blob).toBe(blob);
    expect(bindings.saveController.current).toBeNull();
    rules[0]!.to = "#DDEEFF";
    await exported.save();
    expect(saves).toHaveLength(3);
    expect(saves[2]!.clientOperationId).not.toBe(saves[0]!.clientOperationId);
});
