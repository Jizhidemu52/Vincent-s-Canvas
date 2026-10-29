import { describe, expect, test } from "bun:test";
import { uiText } from "@/lib/i18n";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as nodeAsset from "@/lib/canvas/canvas-node-asset";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { AssetInput } from "@/stores/use-asset-store";

function node(type = CanvasNodeType.Image, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return { id: "source", type, title: "印花.png", position: { x: 20, y: 30 }, width: 320, height: 240, metadata: { content: "data:image/png;base64,YWJjZA==", ...metadata } };
}

describe("canvas node assets preserve the existing save contract", () => {
    test("text trims content and retains attribution, title and prompt", () => {
        const source = node(CanvasNodeType.Text, { content: "  正文 \n", prompt: "012345678901234567890123456789", model: "text-model" });
        expect(nodeAsset.createCanvasNodeAsset(source, "project-a")).toEqual({
            kind: "text", title: "012345678901234567890123", coverUrl: "", tags: [], source: "无线画布", data: { content: "正文" },
            metadata: { source: "canvas", module: "无线画布", nodeId: "source", prompt: source.metadata?.prompt, model: "text-model", projectId: "project-a" },
        });
        expect(nodeAsset.createCanvasNodeAsset(node(CanvasNodeType.Text), "project-a").title).toBe("画布文本");
    });

    test("video preserves storage, dimensions, MIME and encoded recreate URL", () => {
        const asset = nodeAsset.createCanvasNodeAsset(node(CanvasNodeType.Video, { content: "blob:video", storageKey: "video-key", bytes: 99, mimeType: "video/webm", prompt: "场景 & 测试", model: "model/a" }), "project-a");
        expect(asset).toEqual({
            kind: "video", title: "场景 & 测试", coverUrl: "", tags: [], source: "无线画布",
            data: { url: "blob:video", storageKey: "video-key", width: 320, height: 240, bytes: 99, mimeType: "video/webm" },
            metadata: { source: "canvas", module: "无线画布", nodeId: "source", prompt: "场景 & 测试", model: "model/a", projectId: "project-a", recreatePath: `/video?prompt=${encodeURIComponent("场景 & 测试")}&model=model%2Fa` },
        });
        const fallback = nodeAsset.createCanvasNodeAsset(node(CanvasNodeType.Video), "project-a");
        expect(fallback.title).toBe("画布视频");
        expect(fallback.data).toMatchObject({ bytes: 0, mimeType: "video/mp4" });
    });

    test("local image retains bytes, natural pixels, naming, version and edit mode", () => {
        const source = node(CanvasNodeType.Image, { naturalWidth: 1280, naturalHeight: 960, imageName: "花型/原稿.png", imageVersion: 3, generationType: "edit", prompt: "红蓝", model: "image model" });
        const before = structuredClone(source);
        expect(nodeAsset.createCanvasNodeAsset(source, "project-a")).toEqual({
            kind: "image", title: "花型_原稿_v3", coverUrl: source.metadata?.content, tags: [], source: "无线画布",
            data: { dataUrl: source.metadata?.content, storageKey: undefined, width: 1280, height: 960, bytes: 4, mimeType: "image/png" },
            metadata: { source: "canvas", module: "无线画布", nodeId: "source", prompt: "红蓝", model: "image model", projectId: "project-a", recreatePath: `/image?tool=image-edit&prompt=${encodeURIComponent("红蓝")}&model=image%20model`, imageName: "花型/原稿", imageVersion: 3 },
        });
        expect(source).toEqual(before);
    });

    test("stored image omits duplicate data URL and preserves recorded metadata", () => {
        const asset = nodeAsset.createCanvasNodeAsset(node(CanvasNodeType.Image, { content: "/api/assets/original", storageKey: "image-key", bytes: 150, mimeType: "image/jpeg" }), "project-a");
        expect(asset.data).toEqual({ dataUrl: "", storageKey: "image-key", width: 320, height: 240, bytes: 150, mimeType: "image/jpeg" });
        expect(asset.metadata).toMatchObject({ recreatePath: "/image?tool=image-generation&prompt=&model=", imageName: "印花", imageVersion: 1 });
    });

    test.each([
        [CanvasNodeType.Text, " \n", "没有可保存的文本"],
        [CanvasNodeType.Video, "", "没有可保存的视频"],
        [CanvasNodeType.Image, "", "没有可保存的图片"],
    ] as const)("rejects empty %s content", (type, content, error) => {
        expect(() => nodeAsset.createCanvasNodeAsset(node(type, { content }), "project-a")).toThrow(error);
    });
});

// Exercise the editor's actual callback; only the delayed module load and UI/store
// endpoints are replaced, so the race assertions cover the production boundary.
const source = readFileSync(new URL("../src/pages/canvas/project.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("project.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = "";
function visit(value: ts.Node) {
    if (ts.isVariableDeclaration(value) && ts.isIdentifier(value.name) && value.name.text === "saveNodeAsset") callback = `const ${value.getText(ast)};`;
    ts.forEachChild(value, visit);
}
visit(ast);
if (!callback) throw new Error("saveNodeAsset callback not found");
const compiled = ts.transpileModule(`${callback}\nreturn saveNodeAsset;`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;

function editor() {
    let ownerId: string | undefined = "owner-a";
    let resolveModule!: (value: typeof nodeAsset) => void;
    let rejectModule!: (error: unknown) => void;
    let loads = 0;
    const module = new Promise<typeof nodeAsset>((resolve, reject) => { resolveModule = resolve; rejectModule = reject; });
    const assets: AssetInput[] = [], successes: string[] = [], errors: string[] = [];
    const project = { current: "project-a" };
    const scope = {
        uiText,
        projectId: "project-a", designProjectIdRef: project,
        useCallback: (fn: unknown) => fn,
        useUserStore: { getState: () => ({ user: ownerId ? { id: ownerId } : null }) },
        addAsset: (asset: AssetInput) => assets.push(asset),
        message: { success: (text: string) => successes.push(text), error: (text: string) => errors.push(text) },
        require: (path: string) => {
            expect(path).toBe("@/lib/canvas/canvas-node-asset");
            loads += 1;
            return module;
        },
    };
    const save = new Function("scope", `const { ${Object.keys(scope).join(", ")} } = scope;\n${compiled}`)(scope) as (node: CanvasNodeData) => Promise<void>;
    return { save, assets, successes, errors, project, get loads() { return loads; }, resolve: () => resolveModule(nodeAsset), reject: rejectModule, setOwner: (value?: string) => { ownerId = value; } };
}

describe("canvas save action lazy boundary", () => {
    test("does not load at render; loads and saves only after the click", async () => {
        const state = editor();
        expect(state.loads).toBe(0);
        const pending = state.save(node());
        expect(state.assets).toEqual([]);
        state.resolve();
        await pending;
        expect(state.loads).toBe(1);
        expect(state.assets).toEqual([nodeAsset.createCanvasNodeAsset(node(), "project-a")]);
        expect(state.successes).toEqual(["已加入我的素材"]);
        expect(state.errors).toEqual([]);
    });

    test.each(["project", "owner", "logout"] as const)("does not save into a changed %s while the module loads", async (changed) => {
        const state = editor();
        const pending = state.save(node());
        if (changed === "project") state.project.current = "project-b";
        else state.setOwner(changed === "owner" ? "owner-b" : undefined);
        state.resolve();
        await pending;
        expect(state.assets).toEqual([]);
        expect(state.successes).toEqual([]);
        expect(state.errors).toEqual([]);
    });

    test("module failures and empty content report errors without false success", async () => {
        const failed = editor();
        const loading = failed.save(node());
        failed.reject(new Error("加载失败"));
        await loading;
        expect(failed.errors).toEqual(["加载失败"]);
        expect(failed.assets).toEqual([]);
        expect(failed.successes).toEqual([]);
        const empty = editor();
        const saving = empty.save(node(CanvasNodeType.Text, { content: "  " }));
        empty.resolve();
        await saving;
        expect(empty.errors).toEqual(["没有可保存的文本"]);
        expect(empty.assets).toEqual([]);
        expect(empty.successes).toEqual([]);
    });
});
