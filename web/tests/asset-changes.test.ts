import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/services/asset-changes.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("changes.ts", source, ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(ast.statements.filter(item => !ts.isImportDeclaration(item)).map(item => item.getText(ast)).join("\n"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;

function setup() {
    let now = 0, sequence = 0, owner = "employee-a";
    const jobs = new Map<number, { at: number; callback: () => void }>();
    const window = new EventTarget(), document = Object.assign(new EventTarget(), { hidden: false });
    const navigator = { onLine: true };
    const bindings = { window, document, navigator, BroadcastChannel: undefined,
        useUserStore: { getState: () => ({ user: { id: owner } }) },
        setTimeout: (callback: () => void, delay: number) => { const id = ++sequence; jobs.set(id, { at: now + delay, callback }); return id; },
        clearTimeout: (id: number) => jobs.delete(id),
    };
    const exported: { watchVisibleAssetChanges?: (owner: string, refresh: (signal: AbortSignal) => Promise<unknown>) => () => void; notifyAssetsChanged?: (owner: string) => void } = {};
    new Function(...Object.keys(bindings), "exports", code)(...Object.values(bindings), exported);
    const advance = async (milliseconds: number) => {
        now += milliseconds;
        for (const [id, job] of [...jobs]) if (job.at <= now) { jobs.delete(id); job.callback(); }
        await Promise.resolve(); await Promise.resolve();
    };
    return { window, document, navigator, jobs, advance, watch: exported.watchVisibleAssetChanges!, notify: exported.notifyAssetsChanged!, setOwner: (id: string) => { owner = id; } };
}

test("an independent visible client refreshes without local broadcasts and stops when hidden/offline/unmounted", async () => {
    const io = setup(); let reads = 0;
    const stop = io.watch("employee-a", async () => { reads++; });
    await io.advance(19_999); expect(reads).toBe(0);
    await io.advance(1); expect(reads).toBe(1);
    io.document.hidden = true; io.document.dispatchEvent(new Event("visibilitychange"));
    await io.advance(60_000); expect(reads).toBe(1); expect(io.jobs.size).toBe(0);
    io.document.hidden = false; io.document.dispatchEvent(new Event("visibilitychange"));
    await io.advance(200); expect(reads).toBe(2);
    io.navigator.onLine = false; io.window.dispatchEvent(new Event("offline"));
    await io.advance(60_000); expect(reads).toBe(2);
    io.navigator.onLine = true; io.window.dispatchEvent(new Event("online"));
    await io.advance(200); expect(reads).toBe(3);
    stop(); await io.advance(60_000); expect(reads).toBe(3); expect(io.jobs.size).toBe(0);
});

test("upload notifications are owner-scoped and burst updates coalesce", async () => {
    const io = setup(); let reads = 0;
    const stop = io.watch("employee-a", async () => { reads++; });
    io.notify("employee-b"); await io.advance(200); expect(reads).toBe(0);
    for (let i = 0; i < 100; i++) io.notify("employee-a");
    expect(io.jobs.size).toBe(1);
    await io.advance(200); expect(reads).toBe(1);
    stop();
});

test("slow reads do not overlap and changing employee prevents subsequent reads", async () => {
    const io = setup(); let reads = 0;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const stop = io.watch("employee-a", async () => { reads++; await pending; });
    await io.advance(20_000); expect(reads).toBe(1);
    io.notify("employee-a"); await io.advance(200); expect(reads).toBe(1);
    io.setOwner("employee-b"); release(); await io.advance(60_000);
    expect(reads).toBe(1); expect(io.jobs.size).toBe(0); stop();
});

test("failed reads retry only at the visible interval, not a tight error loop", async () => {
    const io = setup(); let reads = 0;
    const stop = io.watch("employee-a", async () => { reads++; throw new Error("offline service"); });
    await io.advance(20_000); expect(reads).toBe(1);
    await io.advance(19_999); expect(reads).toBe(1);
    await io.advance(1); expect(reads).toBe(2); stop();
});
