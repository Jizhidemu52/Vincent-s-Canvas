import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";

function elements(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(elements);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...elements(element.props.children)];
}
function text(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(text).join(" ");
    return React.isValidElement(value) ? text((value as ReactElement<any>).props.children) : "";
}
async function settle() { for (let index = 0; index < 16; index++) await Promise.resolve(); }

// Executes the actual page and effect closures without a DOM or leaking global mocks.
function page(path: string, exportName: string, dependencies: Record<string, unknown>) {
    const url = new URL(path, import.meta.url); const requireModule = createRequire(url);
    const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const values: any[] = []; const effects: Array<{ deps: unknown[]; cleanup?: () => void }> = []; const queued: Array<() => void> = [];
    const timers = new Map<number, () => void>(); let nextTimer = 0; let cursor = 0; let writes = 0;
    const equal = (left: unknown[], right?: unknown[]) => right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
    const hooks = {
        ...React,
        useState(initial: any) { const index = cursor++; if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial; return [values[index], (next: any) => { writes++; values[index] = typeof next === "function" ? next(values[index]) : next; }]; },
        useRef(initial: unknown) { const index = cursor++; return values[index] ||= { current: initial }; },
        useMemo(calculate: () => unknown, deps: unknown[]) { const index = cursor++; if (!values[index] || !equal(deps, values[index].deps)) values[index] = { deps, result: calculate() }; return values[index].result; },
        useCallback(callback: unknown, deps: unknown[]) { return hooks.useMemo(() => callback, deps); },
        useEffect(effect: () => (() => void) | undefined, deps: unknown[]) { const index = cursor++; if (!equal(deps, effects[index]?.deps)) queued.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; }); },
    };
    const mockInput = Object.assign("Input", { Search: "InputSearch", TextArea: "TextArea" });
    const mocks: Record<string, unknown> = {
        react: hooks,
        antd: new Proxy({ App: { useApp: () => ({ message: { success() {}, error() {}, warning() {} }, modal: { confirm() {} } }) }, Input: mockInput, DatePicker: { RangePicker: "RangePicker" } }, { get(target, key) { return key in target ? target[key as keyof typeof target] : String(key); } }),
        ...dependencies,
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", "window", code)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : requireModule(name), module, module.exports, {
        setTimeout(callback: () => void) { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout(id: number) { timers.delete(id); },
    });
    return {
        render(props = {}) { cursor = 0; const tree = module.exports[exportName](props); while (queued.length) queued.shift()!(); return { elements: elements(tree), text: text(tree) }; },
        runTimers() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); },
        unmount() { effects.forEach(effect => effect.cleanup?.()); },
        writes: () => writes,
    };
}

const dashboardData = (count: number) => ({ metrics: { validOutputs: count }, trend: [], directions: [], funnel: [], designers: [], failureReasons: [], tasks: [], assets: [], comparisons: null, options: { users: [], departments: [], groups: [] } });
const countShown = (rendered: ReturnType<ReturnType<typeof page>["render"]>) => rendered.elements.find(element => element.props.label === "有效出图")?.props.value;

test("performance keeps the newest filter result when earlier responses finish last", async () => {
    const pending = [Promise.withResolvers<any>(), Promise.withResolvers<any>()]; let reads = 0;
    const h = page("../src/pages/performance/dashboard.tsx", "PerformanceDashboard", {
        "@/services/api/performance": { designDirectionLabels: {}, getPerformanceDashboard: () => pending[reads++].promise },
    });
    const initial = h.render(); initial.elements.find(element => element.type === "Segmented")!.props.onChange("week"); h.render();
    pending[1].resolve(dashboardData(22)); await settle();
    expect(countShown(h.render())).toBe("22");
    pending[0].resolve(dashboardData(99)); await settle();
    expect(countShown(h.render())).toBe("22");
    h.unmount();
});

test("performance read failures remain visible with retry instead of becoming an empty-data claim", async () => {
    const h = page("../src/pages/performance/dashboard.tsx", "PerformanceDashboard", {
        "@/services/api/performance": { designDirectionLabels: {}, getPerformanceDashboard: async () => { throw new Error("offline fixture"); } },
    });
    h.render(); await settle(); const rendered = h.render();
    const alert = rendered.elements.find(element => element.type === "Alert");
    expect(alert?.props.description).toContain("offline fixture");
    expect(alert?.props.action.props.onClick).toBeInstanceOf(Function);
    expect(rendered.elements.some(element => element.type === "Empty")).toBe(false);
    h.unmount();
});

test("performance abandons updates after unmount", async () => {
    const pending = Promise.withResolvers<any>();
    const h = page("../src/pages/performance/dashboard.tsx", "PerformanceDashboard", {
        "@/services/api/performance": { designDirectionLabels: {}, getPerformanceDashboard: () => pending.promise },
    });
    h.render(); h.unmount(); const writes = h.writes();
    pending.resolve(dashboardData(99)); await settle();
    expect(h.writes()).toBe(writes);
});

test("leaving a group falls back from the remembered team scope to the accessible public library", async () => {
    let user = { id: "personal-designer", groupId: "group", groupRole: "member", role: "designer" };
    const fields = new Map<string, [unknown, (next: unknown) => void]>(); const reads: string[] = [];
    const h = page("../src/pages/prompts/index.tsx", "default", {
        "react-router-dom": { useNavigate: () => () => {} },
        "@/hooks/use-workbench-field": { useWorkbenchField(key: string, initial: unknown) { if (!fields.has(key)) fields.set(key, [initial, (next: any) => { const current = fields.get(key)!; current[0] = typeof next === "function" ? next(current[0]) : next; }]); return fields.get(key); } },
        "@/components/prompts/prompt-template-card": { PromptTemplateCard: "PromptTemplateCard" },
        "@/components/prompts/prompt-template-editor": { PromptTemplateEditor: "PromptTemplateEditor" },
        "@/stores/use-user-store": { useUserStore: (selector: any) => selector({ user }), isAdminRole: () => false },
        "@/services/api/prompts": { listPromptTemplates: async ({ scope }: { scope: string }) => { reads.push(scope); return { templates: [], total: 0 }; } },
    });
    h.render(); h.runTimers(); await settle(); expect(reads).toEqual(["team"]);
    user = { ...user, groupId: "" };
    let rendered = h.render(); h.runTimers(); await settle(); rendered = h.render();
    expect(rendered.elements.find(element => element.type === "Segmented")!.props.value).toBe("public");
    expect(reads.at(-1)).toBe("public");
    h.unmount();
});

test("design-library disabled state distinguishes password authentication from anonymous trial without fetching company content", () => {
    for (const authenticationEnabled of [true, false]) {
        let reads = 0;
        const h = page("../src/pages/design-library/index.tsx", "default", {
            "react-router-dom": { Link: "Link", useLocation: () => ({ pathname: "/design-library" }), useSearchParams: () => [new URLSearchParams(), () => {}] },
            "@/lib/deployment-features": { deploymentFeatures: { authenticationEnabled, oaLoginEnabled: false } },
            "@/stores/use-user-store": { useUserStore: (selector: any) => selector({ user: { id: "personal-designer", role: "designer" } }) },
            "@/services/api/design-library": { listDesignLibrary: async () => { reads++; return { items: [], total: 0 }; } },
            "./entry-detail": { EntryDetail: "EntryDetail", statusLabels: {} },
            "./publish-dialog": { PublishDialog: "PublishDialog" },
        });
        const rendered = h.render();
        expect(rendered.text).toContain(authenticationEnabled ? "个人账号模式" : "本机试用模式");
        if (authenticationEnabled) expect(rendered.text).not.toContain("当前为本机试用模式");
        expect(reads).toBe(0);
        expect(rendered.elements.some(element => element.type === "PublishDialog")).toBe(false);
        h.unmount();
    }
});
