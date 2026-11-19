import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Exercise the real handlers without connecting a local Agent or mounting its SSE effects.
const source = ts.createSourceFile("panel.tsx", readFileSync(new URL("../src/components/canvas/canvas-local-agent-panel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function functionSource(name: string) {
    let found = "";
    const visit = (node: ts.Node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(source);
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) found = `const ${name} = ${node.initializer.getText(source)};`;
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (!found) throw new Error(`Missing handler ${name}`);
    return found;
}

function harness(reader: (file: File) => Promise<string> = async () => "data:image/png;base64,aGVsbG8=", upload: (file: File) => Promise<void> = async () => {}) {
    const messages: any[] = [], requests: any[] = [], originals: any[] = [];
    const userState = { user: { id: "employee-a" } };
    const state: any = { attachments: [], prompt: "make it blue", connected: true, sending: false, waiting: false, activeThreadId: "thread" };
    let serial = 0;
    const scopeRef = { current: "project:user" }, requestRef = { current: null };
    const scope = { useCanvasAgentStore: { getState: () => state }, setAgentState: (patch: any) => Object.assign(state, patch), readDataUrl: reader, createId: () => String(++serial), addMessage: (item: any) => messages.push(item), addEventLog() {}, MAX_ATTACHMENTS: 6, MAX_ATTACHMENT_PAYLOAD_BYTES: 28 * 1024 * 1024, endpoint: "http://isolated.invalid", token: "fixture", snapshotRef: { current: { projectId: "project" } }, fetch: async (_url: string, init: any) => { requests.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ threadId: "thread" }) }; }, URL: { createObjectURL() { throw new Error("No Blob URL allocation is necessary"); }, revokeObjectURL() { throw new Error("Persistent previews must not be revoked"); } } };
    const handlers = () => {
        const code = ts.transpileModule(["attachmentPayloadBytes", "promptWithAttachments", "addAttachments", "removeAttachment", "sendPrompt"].map(functionSource).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
        const values = { ...scope, scopeRef, requestRef, ...state, useUserStore: { getState: () => userState }, uploadUserImage: async (file: File, options: unknown) => { originals.push({ file, options }); await upload(file); } };
        return new Function(...Object.keys(values), `${code}\nreturn { addAttachments, removeAttachment, sendPrompt };`)(...Object.values(values));
    };
    return { state, messages, requests, handlers, scopeRef, requestRef, originals, userState };
}

test("local-agent sent attachment preview remains valid after clearing the draft and remounting handlers", async () => {
    const h = harness();
    await h.handlers().addAttachments([new File(["image"], "photo.png", { type: "image/png" })]);
    expect(h.state.attachments[0].url).toBe(h.state.attachments[0].dataUrl);
    const preview = h.state.attachments[0].url;
    await h.handlers().sendPrompt();
    expect(h.state.attachments).toEqual([]);
    expect(h.messages[0].attachments[0].url).toBe(preview);
    expect(h.requests[0].attachments[0].dataUrl).toBe(preview);
    await h.handlers().addAttachments([new File(["other"], "other.png", { type: "image/png" })]);
    h.handlers().removeAttachment(h.state.attachments[0].id);
    expect(h.state.attachments).toEqual([]);
    expect(h.messages[0].attachments[0].url).toBe(preview);
});

test("local-agent overlapping image reads merge current drafts without resurrecting removed attachments", async () => {
    const reads = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>();
    const h = harness(file => { const pending = Promise.withResolvers<string>(); reads.set(file.name, pending); return pending.promise; });
    const first = h.handlers().addAttachments([new File(["a"], "a.png", { type: "image/png" })]);
    const second = h.handlers().addAttachments([new File(["b"], "b.png", { type: "image/png" })]);
    reads.get("a.png")!.resolve("data:image/png;base64,YQ=="); await first;
    reads.get("b.png")!.resolve("data:image/png;base64,Yg=="); await second;
    expect(h.state.attachments.map((item: any) => item.name)).toEqual(["a.png", "b.png"]);
    const remove = h.handlers().removeAttachment;
    remove(h.state.attachments[0].id); remove(h.state.attachments[0].id);
    expect(h.state.attachments).toEqual([]);
});

test("local-agent failed image reads leave existing drafts intact without creating orphan previews", async () => {
    const h = harness(async file => { if (file.name === "bad.png") throw new Error("decode failed"); return "data:image/png;base64,YQ=="; });
    await h.handlers().addAttachments([new File(["a"], "existing.png", { type: "image/png" })]);
    const before = h.state.attachments;
    await h.handlers().addAttachments([new File(["a"], "good.png", { type: "image/png" }), new File(["a"], "bad.png", { type: "image/png" })]);
    expect(h.state.attachments).toBe(before);
    expect(h.messages.at(-1).title).toBe("图片读取失败");
});

test("local-agent archives the exact image before attachment success without changing the local turn payload", async () => {
    const file = new File(["original bytes"], "original.png", { type: "image/png" });
    const h = harness();
    await h.handlers().addAttachments([file, new File(["text"], "note.txt", { type: "text/plain" })]);
    expect(h.originals).toHaveLength(1);
    expect(h.originals[0].file).toBe(file);
    expect(h.originals[0].options).toEqual({ source: "canvas-local-agent-reference", ownerId: "employee-a" });
    await h.handlers().sendPrompt();
    expect(h.requests[0].attachments).toHaveLength(1);
    expect(h.requests[0].attachments[0].dataUrl).toStartWith("data:image/png;");
    expect(h.requests[0].attachments[0]).not.toHaveProperty("sourceAssetId");
});

test("local-agent cloud failure leaves attachment drafts unchanged", async () => {
    const h = harness(undefined, async () => { throw new Error("原件保存失败"); });
    const before = h.state.attachments;
    await h.handlers().addAttachments([new File(["image"], "photo.png", { type: "image/png" })]);
    expect(h.state.attachments).toBe(before);
    expect(h.messages.at(-1).text).toBe("原件保存失败");
});

test("local-agent late original upload cannot populate a different owner or canvas", async () => {
    const pending = Promise.withResolvers<void>();
    const h = harness(undefined, () => pending.promise);
    const adding = h.handlers().addAttachments([new File(["image"], "photo.png", { type: "image/png" })]);
    await Promise.resolve(); await Promise.resolve();
    h.scopeRef.current = "other-project:employee-b";
    h.userState.user.id = "employee-b";
    pending.resolve(); await adding;
    expect(h.originals[0].options.ownerId).toBe("employee-a");
    expect(h.state.attachments).toEqual([]);
    expect(h.messages).toEqual([]);
});
