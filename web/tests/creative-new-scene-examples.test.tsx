import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { creativeCatalogPresets, creativePresets } from "@/lib/creative-presets";
import { designExampleForScene, designExamplesForScene } from "@/lib/design-examples";
import { DesignExampleArticle } from "@/components/design-examples";
import { i18nHarness } from "./helpers/i18n-harness";

function renderCreativeHome() {
    const sourcePath = new URL("../src/pages/creative/index.tsx", import.meta.url);
    const requireModule = createRequire(sourcePath);
    const compiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const dependencies: Record<string, unknown> = {
        "@/lib/i18n": i18nHarness,
        "react-router-dom": { Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a> },
        "@/stores/use-module-store": { isModuleAvailable: () => true, useModuleStore: (select: (state: { flags: object }) => unknown) => select({ flags: {} }) },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: (state: { tools: unknown[] }) => unknown) => select({ tools: [] }) },
        "@/hooks/use-navigation-preferences": { useNavigationPreferences: () => ({ pinned: [], togglePin() { throw new Error("Rendering must not pin anything"); } }) },
    };
    const module = { exports: {} as { default: () => ReactElement } };
    new Function("require", "module", "exports", compiled)((name: string) => name.endsWith(".css") ? {} : dependencies[name] || requireModule(name), module, module.exports);
    return renderToStaticMarkup(React.createElement(module.exports.default));
}

describe("new creative scene covers and operation examples", () => {
    test("all eight catalog covers resolve to delivered files while standalone scenes retain their assets", () => {
        const html = renderCreativeHome();
        const images = [...html.matchAll(/<img\b[^>]*src="([^"]+)"[^>]*>/g)];
        const sources = images.map(match => match[1]!);
        expect(sources).toHaveLength(8);
        expect(creativeCatalogPresets).toHaveLength(8);
        for (const src of sources) expect(existsSync(resolve(import.meta.dirname, "../public", src.slice(1)))).toBe(true);
        for (const preset of creativePresets.filter(preset => !["virtual-try-on", "sketch-to-photo"].includes(preset.id))) {
            const src = `/creative-scenes/v2/${preset.id}.preview.webp`;
            expect(existsSync(resolve(import.meta.dirname, "../public", src.slice(1)))).toBe(true);
            if (["local-restyle", "garment-colorway", "back-design"].includes(preset.id)) expect(sources).not.toContain(src);
            else expect(sources).toContain(src);
        }
        expect(images.find(match => match[1] === "/design-examples/knit-source.webp")?.[0]).toContain('alt="输入示意 · 毛衫产品图"');
        expect(images.find(match => match[1] === "/design-examples/knit-sketch.webp")?.[0]).toContain('alt="输入示意 · 毛衫结构线稿"');
        expect(html).not.toContain("/virtual-try-on.preview.webp");
        expect(html).not.toContain("/sketch-to-photo.preview.webp");
        expect(html.match(/输入示意 · 毛衫产品图/g)).toHaveLength(2);
        expect(html.match(/输入示意 · 毛衫结构线稿/g)).toHaveLength(2);
    });

    test.each(["virtual-try-on", "sketch-to-photo"])("%s has two usable input-only examples with real assets and exact action labels", sceneId => {
        const examples = designExamplesForScene(sceneId);
        expect(examples).toHaveLength(2);
        expect(examples[0]).toBe(designExampleForScene(sceneId));
        const action = sceneId === "virtual-try-on" ? "生成试穿效果" : "生成实拍效果";
        for (const example of examples) {
            expect(example.steps.map(step => step.title)).toEqual(["输入", "操作", "结果"]);
            expect(example.steps[1]!.detail).toContain(action);
            expect(example.steps[2]!.detail).toContain("仅为输入示意而非实测结果");
            expect(example.prompt).toBeTruthy();
            expect(example.prompt).not.toMatch(/保留绞花|保持绞花|保留六列绞花/);
            for (const media of example.media) {
                expect(media.label).toContain("输入示意");
                expect(existsSync(resolve(import.meta.dirname, "../public", media.src.slice(1)))).toBe(true);
            }
            const html = renderToStaticMarkup(<DesignExampleArticle example={example} />);
            expect(html).toContain("复制示例要求");
            expect(html).toContain(action);
        }
    });

    test("other scenes still contain only their existing practice record", () => {
        for (const preset of creativePresets.filter(preset => !["virtual-try-on", "sketch-to-photo"].includes(preset.id))) {
            expect(designExamplesForScene(preset.id)).toEqual([designExampleForScene(preset.id)!]);
        }
        expect(designExamplesForScene("unknown")).toEqual([]);
    });
});
