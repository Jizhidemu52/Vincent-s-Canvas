import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const code = ts.transpileModule(readFileSync(new URL("../src/lib/workspace-session-events.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

test("a second tab sends only identity invalidation, never credentials, and the first tab sees it immediately", () => {
    const channels: FakeChannel[] = [], sent: unknown[] = [];
    class FakeChannel {
        listeners = new Set<(event: { data: unknown }) => void>();
        constructor(readonly name: string) { channels.push(this); }
        postMessage(data: unknown) { sent.push(data); channels.filter(other => other !== this && other.name === this.name).forEach(other => other.listeners.forEach(listener => listener({ data }))); }
        addEventListener(_name: string, listener: (event: { data: unknown }) => void) { this.listeners.add(listener); }
        removeEventListener(_name: string, listener: (event: { data: unknown }) => void) { this.listeners.delete(listener); }
    }
    function tab() {
        const module = { exports: {} as any };
        new Function("module", "exports", "window", "BroadcastChannel", code)(module, module.exports, { addEventListener() {}, removeEventListener() {} }, FakeChannel);
        return module.exports;
    }
    const a = tab(), b = tab();
    const changes: unknown[] = [];
    const stop = a.subscribeWorkspaceIdentity((owner: unknown) => changes.push(owner));
    b.broadcastWorkspaceIdentity("employee-b");
    expect(changes).toEqual(["employee-b"]);
    expect(Object.keys(sent[0] as object).sort()).toEqual(["nonce", "ownerId", "type"]);
    b.broadcastWorkspaceIdentity(null);
    expect(changes).toEqual(["employee-b", null]);
    stop(); b.broadcastWorkspaceIdentity("employee-c"); expect(changes).toHaveLength(2);
});
