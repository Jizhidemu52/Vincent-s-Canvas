import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const code = ts.transpileModule(readFileSync(new URL("../src/lib/workspace-identity-drain.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
}).outputText;
function drain() {
    const exports = {} as typeof import("@/lib/workspace-identity-drain");
    new Function("exports", code)(exports);
    return exports;
}
async function settle() { for (let i = 0; i < 6; i++) await Promise.resolve(); }

test("identity drain starts synchronously, waits for durable completion and is reentrant-safe", async () => {
    const d = drain();
    const pending = Promise.withResolvers<void>();
    const states: string[] = [];
    let calls = 0;
    d.subscribeWorkspaceIdentityDrain(() => states.push(d.getWorkspaceIdentityDrainStatus()));
    d.registerWorkspaceIdentityDrain(() => { calls++; d.startWorkspaceIdentityDrain(); return pending.promise; });
    d.startWorkspaceIdentityDrain();
    d.startWorkspaceIdentityDrain();
    expect(calls).toBe(1);
    expect(d.getWorkspaceIdentityDrainStatus()).toBe("saving");
    await settle(); expect(d.getWorkspaceIdentityDrainStatus()).toBe("saving");
    pending.resolve(); await settle();
    expect(states).toEqual(["saving", "saved"]);
    d.startWorkspaceIdentityDrain(); expect(calls).toBe(1);
});

test("rejected or throwing drains stay failed without retrying or navigating", async () => {
    for (const synchronous of [false, true]) {
        const d = drain(); let calls = 0;
        d.registerWorkspaceIdentityDrain(() => { calls++; if (synchronous) throw new Error("disk failed"); return Promise.reject(new Error("disk failed")); });
        d.startWorkspaceIdentityDrain(); await settle();
        expect(d.getWorkspaceIdentityDrainStatus()).toBe("failed");
        d.startWorkspaceIdentityDrain(); await settle();
        expect(calls).toBe(1); expect(d.getWorkspaceIdentityDrainStatus()).toBe("failed");
    }
});

test("an invalidation before workspace imports does not initialize a late employee drainer", async () => {
    const d = drain(); let calls = 0;
    d.startWorkspaceIdentityDrain();
    d.registerWorkspaceIdentityDrain(async () => { calls++; });
    await settle();
    expect(d.getWorkspaceIdentityDrainStatus()).toBe("saved");
    expect(calls).toBe(0);
});

test("drain subscriptions detach without changing its terminal state", async () => {
    const d = drain(); const states: string[] = [];
    const unsubscribe = d.subscribeWorkspaceIdentityDrain(() => states.push(d.getWorkspaceIdentityDrainStatus()));
    d.startWorkspaceIdentityDrain(); unsubscribe(); await settle();
    expect(states).toEqual(["saving"]);
    expect(d.getWorkspaceIdentityDrainStatus()).toBe("saved");
});
