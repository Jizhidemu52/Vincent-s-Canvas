import { expect, test } from "bun:test";
import { i18nHarness } from "./helpers/i18n-harness";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as droppedImages from "../src/lib/dropped-images";

const source = readFileSync(new URL("../src/pages/canvas/use-canvas-clipboard-drop.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
function transfer(files: File[] = [], items: any[] = [], values: Record<string, string> = {}) {
    return { files, items, types: files.length || items.length ? ["Files", ...Object.keys(values)] : Object.keys(values), getData: (type: string) => values[type] || "" };
}
function dropHarness() {
    const exports: Record<string, any> = {}, refs: any[] = [], effects: any[] = [];
    let cursor = 0, effectIndex = 0, ownerId = "employee-a", scopeKey = "canvas-a";
    const react = { useRef: (current: unknown) => refs[cursor++] ||= { current }, useCallback: (callback: unknown) => callback,
        useLayoutEffect: (effect: () => void) => effect(), useEffect(effect: () => void | (() => void), deps: unknown[]) {
            if (!deps.length) return; // Clipboard binding is tested independently with a real window.
            const index = effectIndex++, previous = effects[index];
            if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
                previous?.cleanup?.(); effects[index] = { deps, cleanup: effect() };
            }
        } };
    const getState = () => ({ status: "authenticated", user: { id: ownerId } });
    const useUserStore = Object.assign((select: Function) => select(getState()), { getState });
    const dependencies: Record<string, unknown> = { react, "@/lib/i18n": i18nHarness, "@/lib/dropped-images": droppedImages, "@/stores/use-user-store": { useUserStore } };
    new Function("require", "exports", code)((name: string) => dependencies[name], exports);
    const imports: { files: File[]; point: unknown }[] = [], warnings: string[] = [], errors: string[] = [], reading: boolean[] = [];
    let drop: Function;
    const render = () => {
        cursor = 0; effectIndex = 0;
        drop = exports.useCanvasClipboardDrop({ scopeKey, screenToCanvas: (x: number, y: number) => ({ x: x + 1, y: y + 2 }),
            importFiles: async (files: File[], point: unknown) => { imports.push({ files, point }); },
            error: (text: string) => errors.push(text), warning: (text: string) => warnings.push(text), onReadingChange: (value: boolean) => reading.push(value) });
    };
    render();
    return { imports, warnings, errors, reading, drop: (data: ReturnType<typeof transfer>) => drop!({ preventDefault() {}, stopPropagation() {}, dataTransfer: data, clientX: 10, clientY: 20 }),
        switchProject: () => { scopeKey = "canvas-b"; render(); }, switchOwner: () => { ownerId = "employee-b"; render(); }, unmount: () => effects.forEach(effect => effect.cleanup?.()) };
}

test("drop delegates one supported batch to the shared toolbar importer at the captured drop point", async () => {
    const h = dropHarness();
    await h.drop(transfer([new File(["image"], "photo.png", { type: "image/png" }), new File(["video"], "clip.mp4", { type: "video/mp4" }), new File(["audio"], "sound.mp3"), new File(["text"], "notes.txt")]));
    expect(h.imports.map(item => ({ files: item.files.map(file => file.name), point: item.point }))).toEqual([{ files: ["photo.png", "clip.mp4", "sound.mp3"], point: { x: 11, y: 22 } }]);
    expect(h.warnings).toHaveLength(1);
});

test("items-only empty-MIME native images are captured before the event clears and preserve bytes", async () => {
    const h = dropHarness(), file = new File([png], "企业微信原图", { lastModified: 123 });
    const data = transfer([], [{ kind: "file", getAsFile: () => file }]);
    const operation = h.drop(data); data.items = [];
    await operation;
    expect(h.imports).toHaveLength(1);
    expect(h.imports[0]!.files[0]!.type).toBe("image/png");
    expect(h.imports[0]!.files[0]!.lastModified).toBe(123);
    expect(new Uint8Array(await h.imports[0]!.files[0]!.arrayBuffer())).toEqual(png);
});

test("plain text, internal reference sorting, empty and unsupported drops never import", async () => {
    const h = dropHarness();
    await h.drop(transfer());
    await h.drop(transfer([], [], { "text/plain": "正常文字" }));
    await h.drop(transfer([new File([png], "internal.png", { type: "image/png" })], [], { [droppedImages.INTERNAL_IMAGE_DRAG]: "ref-1" }));
    await h.drop(transfer([new File(["text"], "notes.txt")]));
    expect(h.imports).toEqual([]);
});

test("native drops with unreadable virtual files report an actionable error", async () => {
    const h = dropHarness();
    await h.drop(transfer([], [{ kind: "file", getAsFile: () => null }]));
    expect(h.errors.join(" ")).toContain("企业微信");
    expect(h.imports).toEqual([]);
    expect(h.reading.at(-1)).toBe(false);
});

function heldFile() {
    const pending = Promise.withResolvers<ArrayBuffer>();
    const file = new File([png], "late-native-image");
    const originalSlice = file.slice.bind(file);
    file.slice = (...args) => { const chunk = originalSlice(...args); chunk.arrayBuffer = () => pending.promise; return chunk; };
    return { file, release: () => pending.resolve(png.buffer) };
}

test("a late image cannot enter another project, employee or unmounted canvas", async () => {
    for (const change of ["switchProject", "switchOwner", "unmount"] as const) {
        const h = dropHarness(), delayed = heldFile();
        const operation = h.drop(transfer([delayed.file]));
        await Promise.resolve(); h[change](); delayed.release(); await operation;
        expect(h.imports).toEqual([]); expect(h.errors).toEqual([]);
    }
});

test("a second drop is ignored while the first original image is still being read", async () => {
    const h = dropHarness(), delayed = heldFile();
    const operation = h.drop(transfer([delayed.file]));
    await h.drop(transfer([new File([png], "duplicate.png", { type: "image/png" })]));
    delayed.release(); await operation;
    expect(h.imports).toHaveLength(1);
    expect(h.imports[0]!.files[0]!.name).toBe("late-native-image");
    expect(h.warnings).toHaveLength(1);
});
