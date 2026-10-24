import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { canvasAgentUndoMessage } from "@/lib/canvas/canvas-agent-undo-report";

const source = ts.createSourceFile("panel.tsx", readFileSync(new URL("../src/components/canvas/canvas-local-agent-panel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler = "";
let lifetimeEffect = "";
function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "undoLastTool") handler = `const ${node.getText(source)};`;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect" && node.arguments[0]?.getText(source).includes("undoLifetimeRef.current = lifetime")) lifetimeEffect = `const mount = ${node.arguments[0].getText(source)};`;
    ts.forEachChild(node, collect);
}
collect(source);
const code = ts.transpileModule(`${handler}\n${lifetimeEffect}`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

function panel(onUndoOps: () => CanvasAgentSnapshot | null | Promise<CanvasAgentSnapshot | null>) {
    let undoing = false;
    const messages: unknown[] = [], states: unknown[] = [], posts: unknown[] = [], errors: string[] = [];
    const scope = {
        onUndoOps, undoingRef: { current: false }, undoLifetimeRef: { current: { active: true } }, setUndoing: (value: boolean) => { undoing = value; },
        canvasAgentUndoMessage, setAgentState: (state: unknown) => states.push(state), addMessage: (message: unknown) => messages.push(message),
        connected: true, endpoint: "http://isolated.invalid", token: "fixture", clientIdRef: { current: "client" },
        postState: (...args: unknown[]) => posts.push(args.at(-1)), message: { error: (text: string) => errors.push(text) },
    };
    const actions = new Function("scope", `const { ${Object.keys(scope).join(", ")} } = scope;\n${code}\nreturn { undo: undoLastTool, unmount: mount() };`)(scope) as { undo: () => Promise<void>; unmount: () => void };
    return { ...actions, messages, states, posts, errors, undoing: () => undoing };
}
const result: CanvasAgentSnapshot = { projectId: "project", title: "Canvas", nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 }, undoReport: { applied: 1, conflicts: [], retryable: false } };

test("local undo waits for its snapshot, shows loading and ignores repeat clicks", async () => {
    const deferred = Promise.withResolvers<CanvasAgentSnapshot>();
    let calls = 0;
    const view = panel(() => { calls++; return deferred.promise; });
    const first = view.undo();
    expect(view.undoing()).toBe(true);
    await view.undo();
    expect(calls).toBe(1);
    expect(view.messages).toEqual([]);
    expect(view.posts).toEqual([]);
    deferred.resolve(result);
    await first;
    expect(view.undoing()).toBe(false);
    expect(view.messages).toHaveLength(1);
    expect(view.posts).toEqual([result]);
    expect(view.states).toEqual([{ activity: "已撤销" }]);
});

test("cancelled or rejected undo never reports success or posts a Promise as a snapshot", async () => {
    const cancelled = panel(async () => null);
    await cancelled.undo();
    expect(cancelled.posts).toEqual([]);
    expect(cancelled.messages).toEqual([]);
    expect(cancelled.undoing()).toBe(false);
    let calls = 0;
    const failed = panel(async () => { if (!calls++) throw new Error("failure"); return result; });
    await failed.undo();
    expect(failed.errors).toEqual(["撤销失败，请重试。"]);
    expect(failed.messages).toEqual([]);
    expect(failed.undoing()).toBe(false);
    await failed.undo();
    expect(failed.posts).toEqual([result]);
});

test("an unmounted panel emits no late status, messages or state posts", async () => {
    for (const outcome of ["resolve", "reject"]) {
        const deferred = Promise.withResolvers<CanvasAgentSnapshot>();
        const view = panel(() => deferred.promise);
        const pending = view.undo();
        view.unmount();
        if (outcome === "resolve") deferred.resolve(result);
        else deferred.reject(new Error("late failure"));
        await pending;
        expect(view.messages).toEqual([]);
        expect(view.posts).toEqual([]);
        expect(view.states).toEqual([]);
        expect(view.errors).toEqual([]);
        // No React state update is attempted after the component is gone.
        expect(view.undoing()).toBe(true);
    }
});
