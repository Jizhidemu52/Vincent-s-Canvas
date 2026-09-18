import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const requireModule = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL("../src/components/canvas/canvas-save-status.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function statusView(cloudStatus: string, cloudError = "") {
    const state = { cloudStatus, cloudError };
    const module = { exports: {} as any };
    let retries = 0;
    const load = (name: string) => name === "@/stores/canvas/use-canvas-store" ? {
        useCanvasStore: (selector: (value: typeof state) => unknown) => selector(state),
        flushCanvasCloudPersistence: async () => { retries += 1; },
    } : requireModule(name);
    new Function("require", "module", "exports", code)(load, module, module.exports);
    const element = module.exports.CanvasSaveStatus();
    return { element, html: renderToStaticMarkup(element), retries: () => retries };
}

test("local save status explains browser persistence and does not promise cloud recovery", () => {
    const view = statusView("local");
    expect(view.html).toContain("保存在当前浏览器");
    expect(view.html).toContain("同一浏览器、同一地址");
    expect(view.html).toContain("导出画布备份");
    expect(view.html).not.toContain("云端");
});

test("local write failures remain visible and can be retried", () => {
    const view = statusView("local-error", "画布写入本机失败");
    expect(view.html).toContain("画布写入本机失败");
    expect(view.element.props.disabled).toBe(false);
    view.element.props.onClick();
    expect(view.retries()).toBe(1);
});

test("only confirmed cloud completion claims that the server saved the canvas and photos", () => {
    for (const status of ["pending", "syncing", "error"]) {
        const view = statusView(status);
        expect(view.html).not.toContain("画布与图片已保存至服务器");
        expect(view.html).toContain("尚未确认服务器保存成功");
    }
    expect(statusView("synced").html).toContain("画布与图片已保存至服务器");
    expect(statusView("synced").html).toContain("服务器已保存原图");
});
