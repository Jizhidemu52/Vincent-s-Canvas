import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createClientId } from "../src/lib/client-id";

const source = readFileSync(new URL("../src/pages/canvas/use-canvas-clipboard-drop.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
function dropHarness() {
    const exports: Record<string, any> = {};
    new Function("require", "exports", code)((name: string) => name === "@/lib/client-id" ? { createClientId } : ({ useRef: (current: unknown) => ({ current }), useCallback: (callback: unknown) => callback,
        useLayoutEffect: (effect: () => void) => effect(), useEffect() {} }), exports);
    const imported: string[] = [], errors: string[] = [], warnings: string[] = [], progress: Array<{ id: string; completed: number; total: number; failed: number }> = [];
    const create = async (file: File) => { if (file.name === "bad.png") throw new Error("decode failed"); imported.push(file.name); };
    // biome-ignore lint/correctness/useHookAtTopLevel: This isolated harness supplies dependency-free fake React hooks.
    const drop = exports.useCanvasClipboardDrop({ screenToCanvas: () => ({ x: 1, y: 2 }), createImage: create, createVideo: create, createAudio: create,
        error: (value: string) => errors.push(value), warning: (value: string) => warnings.push(value), onImportProgress: (value: any) => progress.push(value) });
    return { imported, errors, warnings, progress, drop: (files: File[]) => drop({ preventDefault() {}, dataTransfer: { files }, clientX: 0, clientY: 0 }) };
}

test("multi-file drop reports real per-file completion, retains valid files and skips unsupported formats", async () => {
    const h = dropHarness();
    await h.drop([new File(["bad"], "bad.png", { type: "image/png" }), new File(["video"], "clip.mp4", { type: "video/mp4" }),
        new File(["image"], "good.png", { type: "image/png" }), new File(["text"], "notes.txt", { type: "text/plain" })]);
    expect(h.imported).toEqual(["clip.mp4", "good.png"]);
    expect(h.errors).toEqual(["bad.png：decode failed"]);
    expect(h.warnings).toHaveLength(1);
    expect(h.progress.map(({ completed, total, failed }) => ({ completed, total, failed }))).toEqual([
        { completed: 0, total: 3, failed: 0 }, { completed: 1, total: 3, failed: 1 }, { completed: 2, total: 3, failed: 1 }, { completed: 3, total: 3, failed: 1 },
    ]);
    expect(new Set(h.progress.map(item => item.id)).size).toBe(1);
    const first = h.progress[0]!.id;
    await h.drop([new File(["audio"], "sound.mp3")]);
    expect(h.progress.at(-1)!.id).not.toBe(first);
    expect(h.imported.at(-1)).toBe("sound.mp3");
});

test("HTTP origins can drop media without crypto.randomUUID", async () => {
    const native = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const secureRandom = crypto.getRandomValues.bind(crypto);
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: secureRandom } });
    try {
        const h = dropHarness();
        await h.drop([new File(["image"], "图片_v2.png", { type: "image/png" })]);
        expect(h.imported).toEqual(["图片_v2.png"]);
        expect(h.errors).toEqual([]);
        expect(h.progress.at(-1)).toMatchObject({ completed: 1, failed: 0, total: 1 });
        expect(h.progress[0]!.id).toMatch(/^canvas-import-[0-9a-f-]{36}$/);
    } finally { if (native) Object.defineProperty(globalThis, "crypto", native); }
});

test("empty and unsupported-only drops cannot leave a loading message open", async () => {
    const h = dropHarness();
    await h.drop([]);
    await h.drop([new File(["text"], "notes.txt")]);
    expect(h.progress).toEqual([]);
    expect(h.imported).toEqual([]);
});
