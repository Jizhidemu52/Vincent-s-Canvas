import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Exercise the page-private batch callback with a deferred chunk load: React state alone cannot close this window.
const source = ts.createSourceFile("use-canvas-batch-edit.ts", readFileSync(new URL("../src/pages/canvas/use-canvas-batch-edit.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function batchCallback(scope: Record<string, unknown>) {
    let callback: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === "runBatchImageEdit" && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (!callback) throw new Error("batch callback missing");
    const code = ts.transpileModule(`const callback = ${callback.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function("scope", `with (scope) { ${code} return callback; }`)(new Proxy(scope, { has: () => true })) as () => Promise<void>;
}

test("batch double clicks before lazy load produce only one execution and release the shared lock", async () => {
    const chunk = Promise.withResolvers<{ runCanvasBatchImageEdit: () => Promise<void> }>();
    const locks = new Set<string>();
    let loads = 0, executions = 0, blocked = 0;
    const run = batchCallback({ generationDispatchLocksRef: { current: locks }, setBatchEditRunning: () => {},
        loadBatchEditRuntime: () => { loads++; return chunk.promise; }, useUserStore: { getState: () => ({ user: null }) }, message: { info: () => blocked++, error: () => {} }, Error });
    const first = run();
    expect([...locks]).toEqual(["canvas-batch"]);
    await run();
    expect(loads).toBe(1);
    expect(blocked).toBe(1);
    chunk.resolve({ runCanvasBatchImageEdit: async () => { executions++; } });
    await first;
    expect(executions).toBe(1);
    expect(locks.size).toBe(0);
});

test("a normal shared-generation lock blocks batch entry and a failed load releases the batch lock", async () => {
    const locks = new Set(["shared-config"]);
    let loads = 0, errors = 0;
    const run = batchCallback({ generationDispatchLocksRef: { current: locks }, setBatchEditRunning: () => {},
        loadBatchEditRuntime: async () => { loads++; throw new Error("chunk unavailable"); }, useUserStore: { getState: () => ({ user: null }) }, message: { info: () => {}, error: () => errors++ }, Error });
    await run();
    expect(loads).toBe(0);
    expect([...locks]).toEqual(["shared-config"]);
    locks.clear();
    await run();
    expect(loads).toBe(1);
    expect(errors).toBe(1);
    expect(locks.size).toBe(0);
});
