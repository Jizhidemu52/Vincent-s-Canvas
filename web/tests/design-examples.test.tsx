import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import ts from "typescript";
import { DesignExampleArticle, PracticeExampleRecord } from "@/components/design-examples";
import { designExampleForLocation, designExampleForScene, designExamples } from "@/lib/design-examples";
import { navigationTools } from "@/constant/navigation-tools";
import { creativePresets, isStandaloneCreativePreset } from "@/lib/creative-presets";

describe("concise illustrated design examples", () => {
    test("all 27 module-specific examples use one short sentence for input, action and result", () => {
        expect(Object.keys(designExamples)).toHaveLength(27);
        for (const example of Object.values(designExamples)) {
            expect(example.steps.map(step => step.title)).toEqual(["输入", "操作", "结果"]);
            for (const step of example.steps) {
                expect(step.detail).toMatch(/^[^。！？\n；]+。$/);
                expect(step.detail.length).toBeLessThanOrEqual(60);
            }
            expect(example.purpose).toMatch(/^[^。！？\n]+。$/);
            expect(example.location).toContain(" → ");
            for (const removed of ["brief", "checks", "cost", "limitation"]) expect(Object.hasOwn(example, removed)).toBe(false);
        }
    });

    test("entry labels match the existing navigation and scene titles", () => {
        for (const tool of navigationTools) {
            const url = new URL(tool.path, "https://canvas.test");
            const example = designExampleForLocation(url.pathname, url.search);
            if (example) expect(example.location).toBe(`左侧导航 → ${tool.label}`);
        }
        for (const preset of creativePresets) {
            expect(designExampleForScene(preset.id)?.location).toBe(`${isStandaloneCreativePreset(preset.id) ? "左侧导航" : "创意设计"} → ${preset.title}`);
        }
        expect(designExamples["reference-import"].location).toBe("素材库 → 网页采集");
        expect(designExampleForLocation("/creative")).toBeUndefined();
        expect(designExampleForLocation("/canvas")).toBeUndefined();
        expect(designExampleForLocation("/team")).toBeUndefined();
        expect(designExampleForLocation("/image", "?tool=unknown")).toBeUndefined();
    });

    test("every retained teaching asset exists and keeps its explicit role", () => {
        for (const example of Object.values(designExamples)) {
            expect(example.media.length).toBeGreaterThan(0);
            for (const media of example.media) {
                expect(media.src).toStartWith("/design-examples/");
                expect(existsSync(resolve(import.meta.dirname, "../public", media.src.slice(1)))).toBe(true);
                if (media.kind === "video") expect(existsSync(resolve(import.meta.dirname, "../public", media.poster.slice(1)))).toBe(true);
                if (media.kind === "video" && media.downloadSrc) expect(existsSync(resolve(import.meta.dirname, "../public", media.downloadSrc.slice(1)))).toBe(true);
                expect(media.label).toMatch(/输入|结果示意|结果视频|参考|方向/);
                expect(media.alt).not.toBe("");
            }
        }
        expect(designExamples["image-edit"].media.map(media => media.label)).toEqual(["输入 · 皮革包原图", "结果示意 · 麂皮包身"]);
        expect(designExamples.video.media[0].label).toBe("输入 · 模特毛衫参考帧");
    });

    test("expanded articles render three compact rows and the actual sample request without warning sections", () => {
        for (const example of Object.values(designExamples)) {
            const html = renderToStaticMarkup(<DesignExampleArticle example={example} />);
            expect(html).toContain(example.purpose);
            expect(html).toContain(example.location);
            expect(html.match(/<dt\b/g)).toHaveLength(3);
            expect(html.match(/<dd\b/g)).toHaveLength(3);
            expect(html.match(/<img\b/g) ?? []).toHaveLength(example.media.filter(media => media.kind !== "video").length);
            expect(html.match(/<video\b/g) ?? []).toHaveLength(example.media.filter(media => media.kind === "video").length);
            expect(html).not.toMatch(/核对要点|费用与执行|使用边界|<pre\b|<details\b|<footer\b/);
            if (example.prompt) {
                expect(html).toContain("复制示例要求");
                expect(html).toContain(example.prompt);
            } else expect(html).not.toContain("复制示例要求");
        }
    });

    test("history examples start collapsed without a drawer, timestamp or task status", () => {
        for (const href of ["/image", "/image?tool=image-edit", "/video", "/creative/garment-colorway"]) {
            const html = renderToStaticMarkup(<MemoryRouter initialEntries={[href]}><PracticeExampleRecord /></MemoryRouter>);
            expect(html).toContain('data-testid="practice-example-record"');
            expect(html).toContain('aria-expanded="false"');
            expect(html).toContain("实操案例");
            expect(html).not.toMatch(/design-example-article|feature-example|ant-drawer|<time\b|成功|失败|已完成/);
            expect(html).not.toContain("本次要求");
        }
        for (const href of ["/creative", "/canvas", "/team", "/image?tool=unknown"]) {
            expect(renderToStaticMarkup(<MemoryRouter initialEntries={[href]}><PracticeExampleRecord /></MemoryRouter>)).toBe("");
        }
    });

    test("summary shows video posters without loading the MP4 or inventing task history", () => {
        const edit = renderToStaticMarkup(<MemoryRouter initialEntries={["/image?tool=image-edit"]}><PracticeExampleRecord /></MemoryRouter>);
        expect(edit.match(/<img\b/g)).toHaveLength(2);
        expect(edit).toContain("输入 · 皮革包原图");
        expect(edit).toContain("结果示意 · 麂皮包身");
        const video = renderToStaticMarkup(<MemoryRouter initialEntries={["/video"]}><PracticeExampleRecord /></MemoryRouter>);
        expect(video.match(/<img\b/g)).toHaveLength(2);
        expect(video).toContain("输入 · 模特毛衫参考帧");
        expect(video).toContain("结果视频 · 模特自然展示与细节");
        expect(video).toContain("/design-examples/model-natural-source.webp");
        expect(video).not.toMatch(/<video\b|\.mp4|taskId|createdAt/);
        expect(video).not.toContain("结果示意");
    });

    test("only the video module contains a playable, normal-speed example with a downloadable original", () => {
        const videos = Object.values(designExamples).flatMap(example => example.media.filter(media => media.kind === "video").map(media => ({ example, media })));
        expect(videos).toHaveLength(1);
        const { example, media } = videos[0];
        expect(example.id).toBe("video");
        expect(media).toMatchObject({ kind: "video", src: "/design-examples/model-natural-showcase.mp4", poster: "/design-examples/model-natural-source.webp" });
        expect(example.prompt).toContain("正常真人速度");
        expect(example.prompt).toContain("镜头连续平稳推近领口、肩线和针织细节");
        expect(example.prompt).not.toMatch(/缓慢|舒缓|包包/);
        const html = renderToStaticMarkup(<DesignExampleArticle example={example} />);
        expect(html).toContain('preload="metadata"');
        expect(html).toMatch(/<video[^>]*controls=""/);
        expect(html).toMatch(/<video[^>]*playsInline=""/);
        expect(html).not.toMatch(/<video[^>]*(?:autoPlay|loop)=/);
        expect(html).toContain('download="model-natural-showcase-original.mp4"');
        expect(html).toContain("下载原视频");
    });
});

const requireComponent = createRequire(new URL("../src/components/design-examples.tsx", import.meta.url));
const componentSource = readFileSync(new URL("../src/components/design-examples.tsx", import.meta.url), "utf8");
const componentCode = ts.transpileModule(componentSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;

function practiceRecord() {
    let expandedId: string | null = null;
    const location = { pathname: "/image", search: "" };
    const copies: string[] = [];
    const dependencies: Record<string, unknown> = {
        react: { ...React, useId: () => "practice-test", useState: () => [expandedId, (value: string | null) => { expandedId = value; }] },
        "react-router-dom": { useLocation: () => location },
        "@/hooks/use-copy-text": { useCopyText: () => (value: string) => { copies.push(value); return Promise.resolve(true); } },
    };
    const module = { exports: {} as { PracticeExampleRecord: typeof PracticeExampleRecord; DesignExampleArticle: typeof DesignExampleArticle } };
    new Function("require", "module", "exports", componentCode)((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireComponent(name), module, module.exports);
    return { location, copies, render: module.exports.PracticeExampleRecord, article: module.exports.DesignExampleArticle };
}

function elements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}

test("practice record expands inline, collapses and keeps a different module closed", () => {
    const record = practiceRecord();
    const toggle = () => elements(record.render()).find(element => element.props["data-testid"] === "practice-example-toggle")!;
    expect(toggle().props["aria-expanded"]).toBe(false);
    toggle().props.onClick();
    expect(toggle().props["aria-expanded"]).toBe(true);
    expect(renderToStaticMarkup(record.render())).toContain('data-testid="design-example-article"');
    record.location.search = "?tool=image-edit";
    expect(toggle().props["aria-expanded"]).toBe(false);
    expect(renderToStaticMarkup(record.render())).toContain('data-example-id="image-edit"');
    toggle().props.onClick();
    toggle().props.onClick();
    expect(toggle().props["aria-expanded"]).toBe(false);
    expect(record.copies).toEqual([]);
});

test("explicit scene examples work without inventing history and generation shortcuts stay inside the record", () => {
    const record = practiceRecord();
    const example = designExamples["creative-garment-colorway"];
    const tree = record.render({ example })!;
    expect(renderToStaticMarkup(tree)).toContain('data-example-id="creative-garment-colorway"');
    let prevented = 0, stopped = 0;
    for (const modifier of ["ctrlKey", "metaKey"]) tree.props.onKeyDown({ key: "Enter", [modifier]: true, preventDefault: () => prevented++, stopPropagation: () => stopped++ });
    expect(prevented).toBe(2); expect(stopped).toBe(2);
    const copy = elements(record.article({ example })).find(element => element.props.onClick)!;
    copy.props.onClick();
    expect(record.copies).toEqual([example.prompt!]);
    expect(componentSource).not.toMatch(/fetch\(|localStorage|createWorkspaceStorage|setItem\(|Date\.now|createdAt|successCount/);
});

test("video metadata starts at 1x and collapse removes its player independently", () => {
    const record = practiceRecord();
    record.location.pathname = "/video";
    const toggle = () => elements(record.render()).find(element => element.props["data-testid"] === "practice-example-toggle")!;
    expect(renderToStaticMarkup(record.render())).not.toContain(".mp4");
    toggle().props.onClick();
    expect(toggle().props["aria-expanded"]).toBe(true);
    const video = elements(record.article({ example: designExamples.video })).find(element => element.type === "video")!;
    const element = { defaultPlaybackRate: 0.5, playbackRate: 0.5 };
    video.props.onLoadedMetadata({ currentTarget: element });
    expect(element).toEqual({ defaultPlaybackRate: 1, playbackRate: 1 });
    expect(video.props.onClick).toBeUndefined();
    expect(video.props.autoPlay).toBeUndefined(); expect(video.props.loop).toBeUndefined();
    expect(video.props.preload).toBe("metadata"); expect(video.props.controls).toBe(true); expect(video.props.playsInline).toBe(true);
    expect(renderToStaticMarkup(record.render())).toContain("<video");
    toggle().props.onClick();
    expect(renderToStaticMarkup(record.render())).not.toContain(".mp4");
    expect(record.copies).toEqual([]);
});
