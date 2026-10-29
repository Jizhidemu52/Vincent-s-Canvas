import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import ts from "typescript";

const previousObserver = globalThis.IntersectionObserver;
afterEach(() => { globalThis.IntersectionObserver = previousObserver; });
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function deferred() { let resolve!: (value: unknown) => void; return { promise: new Promise(done => { resolve = done; }), resolve: (value: unknown) => resolve(value) }; }
function all(value: unknown): ReactElement<any>[] {
    if (Array.isArray(value)) return value.flatMap(all);
    if (!React.isValidElement(value)) return [];
    const element = value as ReactElement<any>;
    return [element, ...all(element.props.children)];
}
function observers() {
    const instances: Array<{ disconnected: boolean; target: unknown; fire: () => void }> = [];
    globalThis.IntersectionObserver = class {
        disconnected = false;
        target: unknown;
        constructor(private callback: (entries: unknown[]) => void) { instances.push(this); }
        observe(target: unknown) { this.target = target; }
        disconnect() { this.disconnected = true; }
        fire() { this.callback([{ isIntersecting: true, target: this.target }]); }
    } as unknown as typeof IntersectionObserver;
    return instances;
}
function harness() {
    const url = new URL('../src/components/infinite-load-more.tsx', import.meta.url);
    const requireModule = createRequire(url);
    const code = ts.transpileModule(readFileSync(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const values: any[] = [], effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [], queued: Array<() => void> = [];
    let cursor = 0;
    const equal = (a: unknown[], b?: unknown[]) => Boolean(b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));
    const hooks = { ...React,
        useRef(initial: unknown) { const index = cursor++; return values[index] ||= { current: initial }; },
        useState(initial: unknown) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], (value: unknown) => { values[index] = value; }]; },
        useCallback(callback: unknown, deps: unknown[]) { const index = cursor++; if (!values[index] || !equal(deps, values[index].deps)) values[index] = { callback, deps }; return values[index].callback; },
        useEffect(effect: () => (() => void) | undefined, deps: unknown[]) { const index = cursor++; if (!equal(deps, effects[index]?.deps)) queued.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; }); },
    };
    const module = { exports: {} as any };
    new Function('require', 'module', 'exports', code)((name: string) => name === '@/lib/i18n' ? requireModule('../../tests/helpers/i18n-harness').i18nHarness : name === 'react' ? hooks : name === 'antd' ? { Button: 'Button' } : requireModule(name), module, module.exports);
    return {
        render(props: any) {
            cursor = 0; const elements = all(module.exports.InfiniteLoadMore(props));
            for (const element of elements) if (element.props.ref) element.props.ref.current = { sentinel: true };
            while (queued.length) queued.shift()!();
            return elements;
        },
        unmount() { effects.forEach(effect => effect.cleanup?.()); },
    };
}
const base = { hasMore: true, loading: false, resetKey: 'owner-a:all', pageKey: 'cursor-60', label: '加载更多素材' };

test('observer deduplicates same-tick entries, protects in-flight loading and permits a new cursor', async () => {
    const seen = observers(), pending = deferred(); let calls = 0;
    const run = () => { calls++; return pending.promise; };
    const component = harness(); component.render({ ...base, onLoadMore: run });
    expect(seen).toHaveLength(1);
    seen[0]!.fire(); seen[0]!.fire(); seen[0]!.fire();
    expect(calls).toBe(1);
    component.render({ ...base, loading: true, onLoadMore: run });
    expect(seen[0]!.disconnected).toBe(true);
    pending.resolve({}); await settle();
    component.render({ ...base, pageKey: 'cursor-120', onLoadMore: async () => { calls++; } });
    seen.at(-1)!.fire(); await settle();
    expect(calls).toBe(2);
    component.unmount(); expect(seen.at(-1)!.disconnected).toBe(true);
});

test('resolved TanStack errors pause automatic loading until one manual retry', async () => {
    const seen = observers(); let calls = 0;
    const run = async () => { calls++; return calls === 1 ? { error: new Error('临时网络错误') } : { error: null }; };
    const component = harness(); component.render({ ...base, onLoadMore: run });
    seen[0]!.fire(); await settle();
    const failed = component.render({ ...base, onLoadMore: run });
    expect(failed.some(element => element.props.role === 'alert')).toBe(true);
    seen[0]!.fire(); seen[0]!.fire(); await settle(); expect(calls).toBe(1);
    const retry = failed.find(element => element.type === 'Button')!;
    expect(retry.props.children).toBe('重试加载更多素材');
    retry.props.onClick(); retry.props.onClick(); await settle();
    expect(calls).toBe(2);
    expect(component.render({ ...base, onLoadMore: run }).some(element => element.props.role === 'alert')).toBe(false);
    component.unmount();
});

test('manual fallback works without IntersectionObserver and unmount blocks stale callbacks', async () => {
    globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
    let calls = 0;
    const component = harness();
    const button = component.render({ ...base, onLoadMore: async () => { calls++; } }).find(element => element.type === 'Button')!;
    button.props.onClick(); await settle(); expect(calls).toBe(1);
    component.unmount(); button.props.onClick(); await settle(); expect(calls).toBe(1);
    const seen = observers(), other = harness(); other.render({ ...base, onLoadMore: async () => { calls++; } });
    other.unmount(); seen[0]!.fire(); await settle();
    expect(calls).toBe(1); expect(seen[0]!.disconnected).toBe(true);
});

test('filter changes clear a previous failure while inactive and exhausted lists never auto-load', async () => {
    const seen = observers(); let calls = 0;
    const component = harness();
    const failing = async () => { calls++; throw new Error('旧筛选错误'); };
    component.render({ ...base, onLoadMore: failing }); seen[0]!.fire(); await settle();
    component.render({ ...base, onLoadMore: failing });
    const next = { ...base, resetKey: 'owner-a:image', onLoadMore: async () => { calls++; } };
    component.render(next); component.render(next); seen.at(-1)!.fire(); await settle(); expect(calls).toBe(2);
    component.render({ ...next, disabled: true, pageKey: 'cursor-120' });
    seen.at(-1)!.fire(); await settle(); expect(calls).toBe(2);
    expect(component.render({ ...next, hasMore: false, endLabel: '已全部加载' }).some(element => element.type === 'Button')).toBe(false);
    component.unmount();
});
