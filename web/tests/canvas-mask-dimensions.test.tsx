import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";
import { canvasMaskEditImageSettings, readCanvasMaskImageSize, type CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { imageModelProfile } from "@/lib/image-model-settings";
import { imageTaskParameters } from "@/services/api/image";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { buildApiMartImageRequest } from "../../server/src/apimart-image";

const markModel = { id: "mark-model", modelId: "mark-model", name: "aplmart-gpt2.5-flare", imageParameterProfile: "quality-resolution" as const, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 };
const markProfile = imageModelProfile(markModel.id, [markModel]);
const globalConfig: AiConfig = { ...defaultConfig, model: markModel.id, imageModel: markModel.id, size: "1:1", quality: "high", imageOptions: JSON.stringify({ resolution: "4k", output_format: "webp", output_compression: "91", background: "opaque", dimensions: "SQUARE" }) };

test("non-square masks lock actual source pixels all the way through the Mark provider request", () => {
    const before = JSON.stringify(globalConfig);
    const locked = canvasMaskEditImageSettings(globalConfig, { width: 768, height: 1024 }, markProfile);
    expect(locked.size).toBe("768x1024");
    expect(locked.quality).toBe("high");
    expect(JSON.parse(locked.imageOptions)).toEqual({ background: "opaque", output_format: "webp", output_compression: "91" });
    const parameters = imageTaskParameters({ ...globalConfig, ...locked }, markProfile, { mask: true });
    expect(parameters).toMatchObject({ size: "768x1024", quality: "high", output_format: "webp", output_compression: 91 });
    expect(parameters).not.toHaveProperty("resolution");
    // Official contract: exact-pixel size takes precedence over the adapter's default resolution.
    const request = buildApiMartImageRequest({ modelId: "gpt-image-2.5-flare", prompt: "edit only the mask", parameters, sourceDataUrls: ["https://reference.invalid/source.png"], maskDataUrl: "data:image/png;base64,AQID" });
    expect(request.payload.size).toBe("768x1024");
    expect(request.payload.resolution).toBe("1k");
    expect(request.payload.mask_url).toBe("data:image/png;base64,AQID");
    expect(JSON.stringify(globalConfig)).toBe(before);
});

test("exact-pixel masked requests omit both explicit and default resolution without changing unmasked requests", () => {
    const exact = { ...globalConfig, size: "768x1024" };
    expect(imageTaskParameters(exact, markProfile, { mask: true })).not.toHaveProperty("resolution");
    expect(imageTaskParameters({ ...exact, imageOptions: "{}" }, markProfile, { mask: true })).not.toHaveProperty("resolution");
    expect(imageTaskParameters(exact, markProfile)).toMatchObject({ size: "768x1024", resolution: "4k" });
    expect(imageTaskParameters({ ...exact, size: "3:4" }, markProfile, { mask: true })).toMatchObject({ size: "3:4", resolution: "4k" });
});

test("source size constraints reject before generation instead of snapping or stretching pixels", () => {
    for (const [width, height] of [[512, 512], [1025, 1024], [4096, 2048], [3840, 3840], [3072, 768]]) {
        expect(() => canvasMaskEditImageSettings(globalConfig, { width: width!, height: height! }, markProfile)).toThrow("尚未提交");
    }
    for (const [width, height] of [[768, 1024], [640, 1024], [1536, 2048], [3840, 2160]]) {
        expect(canvasMaskEditImageSettings(globalConfig, { width: width!, height: height! }, markProfile).size).toBe(`${width}x${height}`);
    }
    expect(() => canvasMaskEditImageSettings(globalConfig, { width: 0, height: 1024 }, markProfile)).toThrow("尚未提交");
    expect(() => canvasMaskEditImageSettings(globalConfig, { width: 768, height: 1024 }, imageModelProfile("gpt-image-1", []))).toThrow("不能按原图");
    expect(canvasMaskEditImageSettings(globalConfig, { width: 768, height: 1024 }, imageModelProfile("gpt-image-2.5-flare", [])).size).toBe("768x1024");
});

test("mask source decoding never substitutes a square default after a decode failure or missing dimensions", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "Image");
    const install = (width: number, height: number, fails = false) => Object.defineProperty(globalThis, "Image", { configurable: true, value: class {
        src = ""; naturalWidth = width; naturalHeight = height;
        async decode() { if (fails) throw new Error("decode failed"); }
    } });
    try {
        install(768, 1024); expect(await readCanvasMaskImageSize("source")).toEqual({ width: 768, height: 1024 });
        install(0, 0); await expect(readCanvasMaskImageSize("broken")).rejects.toThrow("尚未提交");
        install(1024, 1024, true); await expect(readCanvasMaskImageSize("broken")).rejects.toThrow("尚未提交");
    } finally {
        if (original) Object.defineProperty(globalThis, "Image", original);
        else Reflect.deleteProperty(globalThis, "Image");
    }
});

function elements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

function dialog(image: { width: number; height: number }) {
    const requireModule = createRequire(new URL("../src/components/canvas/canvas-node-mask-edit-dialog.tsx", import.meta.url));
    const source = readFileSync(new URL("../src/components/canvas/canvas-node-mask-edit-dialog.tsx", import.meta.url), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    let state = 0;
    const values = [{}, image, "edit the material", 100, "paint", ""];
    const dependencies: Record<string, unknown> = {
        react: { ...React, useEffect: () => {}, useRef: (current: unknown) => ({ current }), useState: (initial: unknown) => [values[state++] ?? initial, () => {}] },
        "@/hooks/use-tool-config": { useToolConfig: (config: unknown) => config, useToolEnabled: () => true },
        "@/stores/use-theme-store": { useThemeStore: (select: (state: unknown) => unknown) => select({ theme: "light" }) },
        "@/lib/image-model-settings": { ...requireModule("@/lib/image-model-settings"), useImageModelProfile: () => markProfile },
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code)((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name), module, module.exports);
    return elements(module.exports.CanvasNodeMaskEditDialog({ dataUrl: "source", open: true, config: globalConfig, model: markModel.id, onModelChange: () => {}, onClose: () => {}, onConfirm: () => {} }));
}

test("mask dialog exposes quality/output only and disables an incompatible original size", () => {
    const legal = dialog({ width: 768, height: 1024 });
    const labels = legal.filter(element => element.type === "select" || element.type === "input").map(element => element.props["aria-label"]);
    expect(labels).toContain("图片质量"); expect(labels).toContain("输出格式");
    expect(labels).not.toContain("宽高比"); expect(labels).not.toContain("清晰度 / 分辨率");
    expect(labels).not.toContain("宽度"); expect(labels).not.toContain("高度");
    expect(legal.find(element => element.props.children === "AI 修改")?.props.disabled).toBe(false);
    const illegal = dialog({ width: 512, height: 512 });
    expect(illegal.find(element => element.props.children === "AI 修改")?.props.disabled).toBe(true);
    expect(illegal.filter(element => element.props.role === "alert").some(element => String(element.props.children).includes("尚未提交"))).toBe(true);
});

async function submitFromProject(sourceSize: { width: number; height: number }, maskSize = sourceSize) {
    const path = new URL("../src/pages/canvas/use-canvas-image-actions.ts", import.meta.url);
    const source = ts.createSourceFile("project.tsx", readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback: ts.ArrowFunction | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === "maskEditImageNode" && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0] as ts.ArrowFunction;
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (!callback) throw new Error("Missing actual project mask submit callback");
    const code = ts.transpileModule(`const submit = ${callback.getText(source).replace('await import("@/components/canvas/canvas-node-mask-edit-dialog")', "await loadMaskModule()")};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const seen: AiConfig[] = [], errors: string[] = [];
    let paidCalls = 0;
    const deps = {
        effectiveConfig: globalConfig, currentToolConfig: (config: AiConfig) => config, modelOptionName: (value: string) => value,
        estimateUsage: () => ({ configured: true, credits: 0 }), buildGenerationConfig: () => globalConfig, imageModelProfile: () => markProfile,
        loadMaskModule: async () => ({ canvasMaskEditImageSettings, readCanvasMaskImageSize: async (value: string) => value === "source" ? sourceSize : maskSize }),
        isAiConfigReady: (config: AiConfig) => { seen.push(config); return false; }, handleMissingModelConfig: () => {},
        message: { error: (error: string) => errors.push(error) }, createOptions: () => { paidCalls++; },
        useUserStore: { getState: () => ({ user: null }) },
    };
    const submit = new Function(...Object.keys(deps), `${code}\nreturn submit;`)(...Object.values(deps));
    await submit({ metadata: { content: "source", size: "1:1", naturalWidth: 1024, naturalHeight: 1024 }, width: 300, height: 300 }, {
        prompt: "mask edit", maskDataUrl: "mask", model: markModel.id,
        imageSettings: { size: "1:1", quality: "xhigh", imageOptions: globalConfig.imageOptions },
    } as CanvasImageMaskEditPayload);
    return { seen, errors, paidCalls };
}

test("actual project submit recomputes pixels after merging payload and ignores stale node/global geometry", async () => {
    const result = await submitFromProject({ width: 768, height: 1024 });
    expect(result.errors).toEqual([]); expect(result.seen).toHaveLength(1);
    expect(result.seen[0]).toMatchObject({ size: "768x1024", quality: "xhigh", count: "1" });
    expect(JSON.parse(result.seen[0]!.imageOptions!)).not.toHaveProperty("resolution");
    expect(result.paidCalls).toBe(0);
});

test("actual project submit blocks unsupported pixels and source/mask mismatch before any task work", async () => {
    for (const result of [await submitFromProject({ width: 512, height: 512 }), await submitFromProject({ width: 768, height: 1024 }, { width: 1024, height: 1024 })]) {
        expect(result.seen).toEqual([]); expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain("尚未提交"); expect(result.paidCalls).toBe(0);
    }
});
