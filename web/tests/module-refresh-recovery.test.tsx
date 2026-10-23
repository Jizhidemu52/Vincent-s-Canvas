import { afterEach, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { useModuleStore } from "../src/stores/use-module-store";

const originalFetch = globalThis.fetch;
const original = useModuleStore.getState();
afterEach(() => { globalThis.fetch = originalFetch; useModuleStore.setState(original, true); });

test("a module polling outage keeps the last enabled flags usable", async () => {
    useModuleStore.setState({ flags: { ...original.flags, image: true }, status: "ready", error: null });
    const flags = useModuleStore.getState().flags;
    globalThis.fetch = (async () => Response.json({}, { status: 502 })) as typeof fetch;
    await expect(useModuleStore.getState().refresh()).rejects.toThrow();
    expect(useModuleStore.getState().status).toBe("ready");
    expect(useModuleStore.getState().flags).toBe(flags);
});

test("initial loading errors show a retry action instead of disabled-module navigation", () => {
    useModuleStore.setState({ status: "error", error: "network" });
    const file = new URL("../src/components/auth/module-gate.tsx", import.meta.url);
    const requireModule = createRequire(file);
    const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const module = { exports: {} as { ModuleGate: React.ComponentType<any> } };
    new Function("require", "module", "exports", code)((name: string) => name === "@/stores/use-module-store" ? { useModuleStore: (selector: (state: unknown) => unknown) => selector(useModuleStore.getState()), useModuleEnabled: () => false } : requireModule(name), module, module.exports);
    const Gate = module.exports.ModuleGate;
    const html = renderToStaticMarkup(<MemoryRouter><Gate moduleKey="image"><span>paid tool</span></Gate></MemoryRouter>);
    expect(html).toContain("重新加载");
    expect(html).toContain("尚未确认模块是否可用");
    expect(html).not.toContain("paid tool");
});

test("explicit permissions failures do not retain the ready state", async () => {
    useModuleStore.setState({ status: "ready" });
    globalThis.fetch = (async () => Response.json({}, { status: 403 })) as typeof fetch;
    await expect(useModuleStore.getState().refresh()).rejects.toThrow();
    expect(useModuleStore.getState().status).toBe("error");
});
