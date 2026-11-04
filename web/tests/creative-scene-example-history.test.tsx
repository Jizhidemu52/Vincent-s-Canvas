import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";
import { creativePresets } from "@/lib/creative-presets";
import { designExampleForScene } from "@/lib/design-examples";
import { createSceneForm } from "@/pages/creative/scene-form-model";
import { i18nHarness } from "./helpers/i18n-harness";

const sourcePath = new URL("../src/pages/creative/scene.tsx", import.meta.url);
const requireModule = createRequire(sourcePath);
const compiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;

function PracticeExampleRecord() { return null; }

function harness(sceneId = "style-to-sketch", recoveredRequestId?: string) {
    const states: unknown[] = [];
    const effectDeps: Array<readonly unknown[] | undefined> = [];
    const pendingEffects: Array<() => void> = [];
    const calls = { generated: 0, reset: 0, previews: [] as unknown[] };
    let stateIndex = 0, effectIndex = 0;
    const ws = {
        form: createSceneForm(sceneId), images: {}, selection: null,
        config: { size: "1024x1024", quality: "auto" }, model: "model", count: 1,
        loading: false, running: false, uploading: false, validation: "", quotaBlocked: false,
        recoveredRequestId, logs: [] as Array<{ id: string; createdAt: number; successCount: number; failCount: number }>,
        results: [], historyTotal: 0, historyHasMore: false, selectedPrompt: null,
        generate: () => { calls.generated++; }, reset: () => { calls.reset++; },
        previewLog: (log: unknown) => { calls.previews.push(log); },
    };
    const dependencies: Record<string, unknown> = {
        "@/lib/i18n": i18nHarness,
        react: { ...React,
            useState(initial: unknown) {
                const index = stateIndex++;
                if (!(index in states)) states[index] = initial;
                return [states[index], (value: unknown) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
            },
            useEffect(effect: () => void, deps: readonly unknown[]) {
                const index = effectIndex++, previous = effectDeps[index];
                if (previous && deps.every((value, item) => Object.is(value, previous[item]))) return;
                effectDeps[index] = deps;
                pendingEffects.push(effect);
            },
        },
        antd: { App: { useApp: () => ({ modal: { confirm() {} } }) }, Image: () => null },
        "react-router-dom": { Link: () => null, useParams: () => ({ presetId: sceneId }), useNavigate: () => () => {} },
        "@/components/design-examples": { PracticeExampleRecord },
        "@/components/auth/module-gate": { ModuleGate: () => null },
        "@/components/image-settings-panel": { ImageSettingsPanel: () => null, imageQualityLabel: (value: string) => value, imageSizeLabel: (value: string) => value },
        "@/components/model-picker": { ModelPicker: () => null },
        "@/stores/use-module-store": { useModuleEnabled: () => false, isModuleAvailable: () => true, useModuleStore: (select: Function) => select({ flags: {} }) },
        "@/stores/use-business-config-store": { useBusinessConfigStore: (select: Function) => select({ tools: [] }) },
        "@/stores/use-theme-store": { useThemeStore: (select: Function) => select({ theme: "light" }) },
        "@/stores/use-user-store": { useUserStore: (select: Function) => select({ user: { id: "owner" } }) },
        "./use-scene-workspace": { useSceneWorkspace: () => ws },
        "./scene-form": { SceneFields: () => null, SceneUploads: () => null },
        "./region-selection-dialog": { RegionSelectionDialog: () => null },
        "./recolor-dialog": { RecolorDialog: () => null },
        "./vector-trace-dialog": { VectorTraceDialog: () => null },
    };
    const module = { exports: {} as { default: () => ReactElement<any> } };
    new Function("require", "module", "exports", compiled)((name: string) => name.endsWith(".css") ? {} : dependencies[name] || requireModule(name), module, module.exports);
    const render = () => {
        stateIndex = effectIndex = 0;
        const gate = module.exports.default();
        const workspace = gate.props.children;
        const output = workspace.type(workspace.props);
        pendingEffects.splice(0).forEach(effect => effect());
        return output;
    };
    return { render, ws, calls };
}

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement<any>(node)) return [];
    return [node, ...elements(node.props.children)];
}

function text(node: unknown): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    return React.isValidElement<any>(node) ? text(node.props.children) : "";
}

function button(node: unknown, label: string) {
    return elements(node).find(item => item.type === "button" && text(item) === label)!;
}

test("each creative scene starts in history with only its own practice record, outside real logs and counts", () => {
    for (const preset of creativePresets) {
        const app = harness(preset.id);
        const output = app.render();
        const records = elements(output).filter(item => item.type === PracticeExampleRecord);
        expect(records).toHaveLength(1);
        expect(records[0]!.props.example).toBe(designExampleForScene(preset.id));
        const history = elements(output).find(item => item.props.className === "cs-history")!;
        expect(elements(history)[1]!.type).toBe(PracticeExampleRecord);
        expect(button(output, "最近任务").props["aria-pressed"]).toBe(true);
        expect(button(output, "功能示例")).toBeUndefined();
        expect(elements(history).some(item => item.props.className === "cs-empty")).toBe(false);
        expect(app.ws.logs).toEqual([]);
        expect(app.ws.historyTotal).toBe(0);
        expect(app.calls.generated).toBe(0);
    }
});

test("new task and the empty result link return to history without generating", () => {
    const app = harness();
    button(app.render(), "当前结果").props.onClick();
    let output = app.render();
    expect(elements(output).some(item => item.type === PracticeExampleRecord)).toBe(false);
    button(output, "看看实操案例").props.onClick();
    expect(elements(app.render()).some(item => item.type === PracticeExampleRecord)).toBe(true);
    button(app.render(), "当前结果").props.onClick();
    button(app.render(), "新建任务").props.onClick();
    output = app.render();
    expect(button(output, "最近任务").props["aria-pressed"]).toBe(true);
    expect(app.calls.reset).toBe(1);
    expect(app.calls.generated).toBe(0);
});

test("recovering a pending request still opens results and permits a later manual history visit", () => {
    const app = harness("style-to-sketch", "existing-request");
    app.render();
    expect(button(app.render(), "当前结果").props["aria-pressed"]).toBe(true);
    button(app.render(), "最近任务").props.onClick();
    expect(elements(app.render()).some(item => item.type === PracticeExampleRecord)).toBe(true);
    expect(app.calls.generated).toBe(0);
});

test("real history retains its count and preview action while the example stays separate", () => {
    const app = harness();
    const log = { id: "real-log", createdAt: 100, successCount: 2, failCount: 0 };
    app.ws.logs = [log];
    app.ws.historyTotal = 1;
    const output = app.render();
    expect(button(output, "最近任务1").props["aria-pressed"]).toBe(true);
    const record = elements(output).find(item => item.props.className === "cs-history-item")!;
    record.props.onClick();
    expect(app.calls.previews).toEqual([log]);
    expect(button(app.render(), "当前结果").props["aria-pressed"]).toBe(true);
    expect(app.ws.logs).toEqual([log]);
    expect(app.ws.historyTotal).toBe(1);
    expect(app.calls.generated).toBe(0);
});

test("submit shortcut is limited to editable form content, not history or small action buttons", () => {
    const app = harness();
    const output = app.render();
    expect(output.props.onKeyDown).toBeUndefined();
    const form = elements(output).find(item => item.props.className === "cs-form-panel")!;
    const event = { key: "Enter", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, nativeEvent: {}, preventDefault() {}, target: { closest: () => ({}) } };
    form.props.onKeyDown(event);
    expect(app.calls.generated).toBe(0);
    form.props.onKeyDown({ ...event, target: { closest: () => null } });
    expect(app.calls.generated).toBe(1);
    expect(button(app.render(), "当前结果").props["aria-pressed"]).toBe(true);
});
