import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Native IndexedDB concurrency/abort behavior is exercised by
// canvas-indexeddb.browser.mjs. These tests cover the non-IndexedDB safety path.
const source = readFileSync(new URL("../src/lib/canvas/canvas-atomic-storage.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("storage.ts", source, ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(ast.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getText(ast)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;

function storageHarness(options: { locks?: boolean; readyError?: Error } = {}) {
    const values = new Map<string, string>([["canvas", "7"], ["unrelated-assets", "keep original images"]]);
    let serialized = Promise.resolve();
    const bindings = {
        window: {}, navigator: { locks: options.locks ? {} : undefined },
        localforage: { INDEXEDDB: "asyncStorage", driver: () => "localStorageWrapper", async ready() { if (options.readyError) throw options.readyError; } },
        localForageStorage: {
            async getItem(name: string) { return values.get(name) ?? null; },
            async setItem(name: string, value: string) { values.set(name, value); },
            async removeItem(name: string) { values.delete(name); },
        },
        withCanvasStorageLock: (_name: string, callback: () => Promise<void>) => { const next = serialized.catch(() => undefined).then(callback); serialized = next; return next; },
    };
    const exports = {} as { updateCanvasStorage: (name: string, update: (stored: string | null) => string | null) => Promise<void> };
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exports);
    return { values, update: exports.updateCanvasStorage };
}

test("a non-IndexedDB browser without Web Locks refuses an unsafe write and leaves existing data intact", async () => {
    const storage = storageHarness();
    let updateRan = false;
    await expect(storage.update("canvas", () => { updateRan = true; return "unsafe"; })).rejects.toThrow("无法安全保存画布");
    expect(updateRan).toBe(false);
    expect(storage.values.get("canvas")).toBe("7");
    expect(storage.values.get("unrelated-assets")).toBe("keep original images");
});

test("a non-IndexedDB browser with Web Locks reads the latest value inside each protected write", async () => {
    const storage = storageHarness({ locks: true });
    await Promise.all(Array.from({ length: 10 }, () => storage.update("canvas", current => String(Number(current) + 1))));
    expect(storage.values.get("canvas")).toBe("17");
    expect(storage.values.get("unrelated-assets")).toBe("keep original images");
});

test("a failed merge does not write a replacement and a subsequent locked save can succeed", async () => {
    const storage = storageHarness({ locks: true });
    await expect(storage.update("canvas", () => { throw new Error("invalid snapshot"); })).rejects.toThrow("invalid snapshot");
    expect(storage.values.get("canvas")).toBe("7");
    await storage.update("canvas", current => `${current}:recovered`);
    expect(storage.values.get("canvas")).toBe("7:recovered");
});

test("initialization failure does not silently write to a different storage backend", async () => {
    const storage = storageHarness({ locks: true, readyError: new Error("storage unavailable") });
    await expect(storage.update("canvas", () => "lost baseline")).rejects.toThrow("storage unavailable");
    expect(storage.values.get("canvas")).toBe("7");
});

test("explicit canvas-key removal leaves unrelated local assets untouched", async () => {
    const storage = storageHarness({ locks: true });
    await storage.update("canvas", () => null);
    expect(storage.values.has("canvas")).toBe(false);
    expect(storage.values.get("unrelated-assets")).toBe("keep original images");
});
