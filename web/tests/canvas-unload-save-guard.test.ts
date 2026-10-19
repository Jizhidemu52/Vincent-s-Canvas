import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/pages/canvas/use-canvas-persistence.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("project.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect = "";
function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect" && node.arguments[0]?.getText(ast).includes('window.addEventListener("beforeunload"')) effect = node.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
}
visit(ast);
const code = ts.transpileModule(`const install = ${effect};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

function harness(editorPending: boolean, storagePending: boolean, fail = false) {
    const listeners = new Map<string, (event: unknown) => void>();
    const calls: string[] = [];
    const target = {
        addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
        removeEventListener: (name: string) => listeners.delete(name),
        visibilityState: "visible",
    };
    const queue = { hasPending: () => editorPending, flush: () => { calls.push("editor"); editorPending = false; } };
    const cleanup = new Function("window", "document", "projectSaveQueueRef", "hasPendingCanvasPersistence", "flushCanvasPersistence", `${code}\nreturn install();`)(
        target, target, { current: queue }, () => storagePending,
        () => { calls.push("store"); return fail ? Promise.reject(new Error("disk unavailable")) : Promise.resolve(); },
    );
    const refresh = () => {
        const event = { defaultPrevented: false, returnValue: undefined as string | undefined, preventDefault() { this.defaultPrevented = true; } };
        listeners.get("beforeunload")!(event);
        return event;
    };
    return { listeners, calls, refresh, cleanup };
}

test("a refresh with an editor draft flushes both queues and requests an unload warning", () => {
    const run = harness(true, false);
    const event = run.refresh();
    expect(run.calls).toEqual(["editor", "store"]);
    expect(event.defaultPrevented).toBe(true);
    expect(event.returnValue).toBe("");
    run.cleanup();
    expect(run.listeners.size).toBe(0);
});

test("an in-flight or failed storage write remains protected after the editor queue empties", async () => {
    const run = harness(false, true, true);
    expect(run.refresh().defaultPrevented).toBe(true);
    await Promise.resolve();
    run.cleanup();
    await Promise.resolve();
});

test("a fully saved document refreshes without an unload warning", () => {
    const run = harness(false, false);
    const event = run.refresh();
    expect(event.defaultPrevented).toBe(false);
    expect(event.returnValue).toBeUndefined();
    expect(run.calls).toEqual(["editor", "store"]);
    run.cleanup();
});
