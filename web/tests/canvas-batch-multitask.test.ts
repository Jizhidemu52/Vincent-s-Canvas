import { expect, test } from "bun:test";
import { QueuedTaskHttpError, QueuedTaskSubmissionUncertainError } from "@/services/api/generation-tasks";
import { batchHarness, settleBatch } from "./canvas-batch-test-harness";

test("A remains in flight while B submits; reverse completions keep both batches and never steal selection", async () => {
    const h = batchHarness();
    const a = h.draft("a"), aId = a.activeBatchEditId;
    const aRun = a.runBatchImageEdit(); await settleBatch();
    expect(h.submissions).toHaveLength(1);
    h.render().createBatchEdit();
    const b = h.draft("b"), bId = b.activeBatchEditId;
    const bRun = b.runBatchImageEdit(); await settleBatch();
    expect(h.submissions).toHaveLength(2);
    expect(h.submissions.map(item => item.prompt)).toEqual(["prompt-a", "prompt-b"]);
    expect(h.submissions.map(item => item.options.projectId)).toEqual(["project-a", "project-a"]);
    expect(h.render().batchEditBatches.filter(item => item.running)).toHaveLength(2);
    expect(h.nodes.current.filter(node => node.metadata.imageTask)).toHaveLength(2);
    expect(h.persisted.map(entry => entry.id)).toEqual(["project-a", "project-a"]);

    h.render().setBatchEditOpen(false);
    h.selected.current = new Set(["later-user-selection"]);
    expect(h.submissions.every(item => !item.options.signal.aborted)).toBe(true);
    h.complete(1); await bRun;
    expect(h.render().activeBatchEditId).toBe(bId);
    expect(h.render().batchEditServerId).toBe("server-2");
    expect(h.render().batchEditItems[0].resultUrl).toBe("result:server-2:0");
    expect(h.render().batchEditBatches.find(item => item.id === aId)?.running).toBe(true);

    await h.submissions[0].options.onCompiled("compiled-a", true);
    h.complete(0); await aRun;
    expect(h.render().batchEditServerId).toBe("server-2");
    expect(h.render().batchEditPrompt).toBe("prompt-b");
    expect(h.render().batchEditOpen).toBe(false);
    expect([...h.selected.current]).toEqual(["later-user-selection"]);
    h.render().selectBatchEdit(aId); h.render().setBatchEditOpen(true);
    expect(h.render().batchEditItems[0].resultUrl).toBe("result:server-1:0");
    expect(h.render().batchEditItems[0].requestId).toBe("request-1");
    expect(h.nodes.current).toHaveLength(4);
    expect(h.assets).toHaveLength(2);
    expect(h.controls).toEqual([]);
    expect(h.submissions).toHaveLength(2);
    expect(h.locks.size).toBe(0);
    h.unmount();
});

test("stale A input and run callbacks cannot touch B or regain authority after A-B-A selection", async () => {
    const h = batchHarness();
    const a = h.draft("a"), aId = a.activeBatchEditId;
    a.createBatchEdit(); const b = h.draft("b");
    a.setBatchEditPrompt("late-a");
    a.setBatchImageSettings(current => ({ ...current, model: "late-model" }));
    a.setBatchEditItems([]);
    await a.runBatchImageEdit();
    expect(h.render().batchEditPrompt).toBe("prompt-b");
    expect(h.render().batchImageSettings.model).toBe("gpt-image-2");
    expect(h.render().batchEditItems).toHaveLength(1);
    expect(h.submissions).toEqual([]);
    b.selectBatchEdit(aId); h.render();
    a.setBatchEditPrompt("late-again");
    a.setBatchImageSettings({ model: "late-again" });
    expect(h.render().batchEditPrompt).toBe("prompt-a");
    expect(h.render().batchImageSettings.model).toBe("gpt-image-2");
    h.unmount();
});

test("late file preparation cannot replace a newer input or an A-B-A selection", async () => {
    const h = batchHarness();
    const a = h.draft("a"), aId = a.activeBatchEditId;
    const loading = a.applyBatchEditFiles([new File(["png"], "late.png", { type: "image/png" })]);
    a.createBatchEdit(); h.render().selectBatchEdit(aId); h.render();
    await loading;
    expect(h.render().batchEditItems.map(item => item.relativePath)).toEqual(["a.png"]);
    h.unmount();
});

test("editing prompt and settings during file preparation preserves both selected files and current inputs", async () => {
    const h = batchHarness();
    const form = h.render();
    const selected = ["one.png", "two.png"].map(name => new File(["png"], name, { type: "image/png" }));
    const loading = form.applyBatchEditFiles(selected);
    form.setBatchEditPrompt("只把领口改成 V 领");
    form.setBatchOptimizePrompt(true);
    form.setBatchImageSettings({ model: "gpt-image-2", size: "1:1" });
    await loading;
    const current = h.render();
    expect(current.batchEditItems.map(item => item.file)).toEqual(selected);
    expect(current.batchEditPrompt).toBe("只把领口改成 V 领");
    expect(current.batchOptimizePrompt).toBe(true);
    expect(current.batchImageSettings).toEqual({ model: "gpt-image-2", size: "1:1" });
    expect(h.submissions).toEqual([]);
    h.unmount();
});

test("a newer file selection supersedes earlier preparation even before either list is ready", async () => {
    const h = batchHarness();
    const form = h.render();
    const first = form.applyBatchEditFiles([new File(["png"], "first.png", { type: "image/png" })]);
    const second = form.applyBatchEditFiles([new File(["png"], "second.png", { type: "image/png" })]);
    await Promise.all([first, second]);
    expect(h.render().batchEditItems.map(item => item.relativePath)).toEqual(["second.png"]);
    h.unmount();
});

test("explicitly clearing files invalidates preparation without losing later prompt edits", async () => {
    const h = batchHarness();
    const form = h.draft("a");
    const loading = form.applyBatchEditFiles([new File(["png"], "late.png", { type: "image/png" })]);
    form.setBatchEditItems([]);
    form.setBatchEditPrompt("new prompt");
    await loading;
    expect(h.render().batchEditItems).toEqual([]);
    expect(h.render().batchEditPrompt).toBe("new prompt");
    h.unmount();
});

test("batch templates atomically create B without overwriting running A or a nonempty draft", async () => {
    const h = batchHarness();
    const emptyId = h.render().activeBatchEditId;
    h.render().applyBatchEditTemplate("template-empty", { model: "gpt-image-2" });
    expect(h.render().activeBatchEditId).toBe(emptyId);
    const a = h.draft("a"), aId = a.activeBatchEditId;
    const aRun = a.runBatchImageEdit(); await settleBatch();
    h.render().applyBatchEditTemplate("template-b", { model: "b-model" });
    const bId = h.render().activeBatchEditId;
    expect(bId).not.toBe(aId);
    expect(h.render().batchEditPrompt).toBe("template-b");
    expect(h.render().batchImageSettings.model).toBe("b-model");
    h.render().applyBatchEditTemplate("template-c", { model: "c-model" });
    expect(h.render().activeBatchEditId).not.toBe(bId);
    h.render().selectBatchEdit(aId);
    expect(h.render().batchEditPrompt).toBe("prompt-a");
    expect(h.render().batchEditRunning).toBe(true);
    h.complete(0); await aRun; h.unmount();
});

test("an in-flight A control stays bound to A after selecting B and double controls do not duplicate", async () => {
    const h = batchHarness();
    const a = h.draft("a"), aId = a.activeBatchEditId;
    const aRun = a.runBatchImageEdit(); await settleBatch();
    h.render().createBatchEdit(); const b = h.draft("b"), bId = b.activeBatchEditId;
    const bRun = b.runBatchImageEdit(); await settleBatch();
    h.render().selectBatchEdit(aId); const activeA = h.render();
    const pause = activeA.controlActiveBatchEdit("pause");
    await activeA.controlActiveBatchEdit("pause");
    h.render().selectBatchEdit(bId); await pause;
    expect(h.controls).toEqual([{ id: "server-1", action: "pause" }]);
    expect(h.render().batchEditServerId).toBe("server-2");
    expect(h.render().batchEditAction).toBeNull();
    h.complete(0); h.complete(1); await Promise.all([aRun, bRun]); h.unmount();
});

test.each(["account", "project"] as const)("%s A-B-A cannot revive old batch callbacks or reuse old dispatch authority", async boundary => {
    const h = batchHarness();
    const old = h.draft("a"), run = old.runBatchImageEdit(); await settleBatch();
    if (boundary === "account") { h.switchAccount(); h.switchAccount("owner-a"); }
    else { h.switchProject(); h.switchProject("project-a"); }
    h.draft("new-a");
    old.setBatchEditPrompt("stale-owner-prompt");
    old.setBatchImageSettings({ model: "stale-model" });
    await old.runBatchImageEdit();
    expect(h.render().batchEditPrompt).toBe("prompt-new-a");
    expect(h.render().batchImageSettings.model).toBe("gpt-image-2");
    h.complete(0); await run;
    expect(h.submissions).toHaveLength(1);
    expect(h.assets).toEqual([]);
    expect(h.render().batchEditPrompt).toBe("prompt-new-a");
    h.unmount();
});

test.each(["account", "project", "role", "unmount", "lease"] as const)("leaving %s revokes late result callbacks without cancelling accepted batches", async boundary => {
    const h = batchHarness();
    const aRun = h.draft("a").runBatchImageEdit(); await settleBatch();
    const originalNodes = structuredClone(h.nodes.current), originalWrites = h.persisted.length;
    if (boundary === "account") h.switchAccount();
    else if (boundary === "project") h.switchProject();
    else if (boundary === "role") h.changeRole("super_admin");
    else if (boundary === "lease") h.revokeLease();
    else h.unmount();
    if (boundary !== "lease") {
        expect(h.submissions[0].options.signal.aborted).toBe(true);
        expect(h.submissions[0].options.cancelOnAbort()).toBe(false);
    }
    const late = await Promise.allSettled([h.submissions[0].options.onCompiled("late-compiled", true),
        h.submissions[0].options.onProgress([{ itemIndex: 0, status: "success" }])]);
    expect(late.every(item => item.status === "rejected")).toBe(true);
    h.complete(0); await aRun;
    expect(h.nodes.current).toEqual(originalNodes);
    expect(h.persisted).toHaveLength(originalWrites);
    expect(h.assets).toEqual([]);
    expect(h.controls).toEqual([]);
    if (boundary !== "unmount") h.unmount();
});

test.each(["account", "project", "role", "unmount"] as const)("leaving %s during local source upload cannot append nodes or submit", async boundary => {
    const uploading = Promise.withResolvers<void>();
    const h = batchHarness({ upload: input => typeof input === "string" ? Promise.resolve() : uploading.promise });
    const run = h.draft("a").runBatchImageEdit(); await settleBatch();
    if (boundary === "account") h.switchAccount();
    else if (boundary === "project") h.switchProject();
    else if (boundary === "role") h.changeRole("super_admin");
    else h.unmount();
    uploading.resolve(); await run;
    expect(h.submissions).toEqual([]);
    expect(h.nodes.current).toEqual([]);
    expect(h.persisted).toEqual([]);
    expect(h.assets).toEqual([]);
    expect(h.controls).toEqual([]);
    if (boundary !== "unmount") h.unmount();
});

test("revocation during binding persistence blocks the model POST and keeps original request binding", async () => {
    const persistence = Promise.withResolvers<void>();
    const h = batchHarness({ persist: () => persistence.promise });
    const run = h.draft("a").runBatchImageEdit(); await settleBatch();
    expect(h.nodes.current.some(node => node.metadata.imageTask?.requestId === "request-1:0")).toBe(true);
    h.switchProject();
    persistence.resolve(); await run;
    expect(h.submissions).toEqual([]);
    expect(h.controls).toEqual([]);
    h.unmount();
});

test("lease loss before a rejected observation keeps prior bindings without writing late failure metadata", async () => {
    const h = batchHarness();
    const run = h.draft("a").runBatchImageEdit(); await settleBatch();
    const originalNodes = structuredClone(h.nodes.current), originalWrites = h.persisted.length;
    h.revokeLease();
    h.fail(0, new QueuedTaskSubmissionUncertainError("request-1")); await run;
    expect(h.nodes.current).toEqual(originalNodes);
    expect(h.persisted).toHaveLength(originalWrites);
    expect(h.submissions[0].options.signal.aborted).toBe(true);
    expect(h.submissions[0].options.cancelOnAbort()).toBe(false);
    h.unmount();
});

test("unknown A preserves its original request and cannot resubmit, while independent B remains available", async () => {
    const h = batchHarness();
    const a = h.draft("a"), aId = a.activeBatchEditId;
    const run = a.runBatchImageEdit(); await settleBatch();
    h.fail(0, new QueuedTaskSubmissionUncertainError("request-1")); await run;
    expect(h.render().batchEditItems[0].status).toBe("paused");
    expect(h.render().batchEditItems[0].requestId).toBe("request-1");
    expect(h.render().batchEditBatches[0].status).toBe("pending");
    const nodes = structuredClone(h.nodes.current);
    h.render().setBatchEditItems([]);
    h.render().setBatchEditPrompt("overwrite unknown");
    await h.render().applyBatchEditFiles([new File(["png"], "a-again.png", { type: "image/png" })]);
    expect(h.render().batchEditItems[0].requestId).toBe("request-1");
    expect(h.render().batchEditPrompt).toBe("prompt-a");
    await h.render().runBatchImageEdit();
    expect(h.submissions).toHaveLength(1);
    expect(h.nodes.current).toEqual(nodes);
    h.render().createBatchEdit(); const bRun = h.draft("b").runBatchImageEdit(); await settleBatch();
    expect(h.submissions).toHaveLength(2);
    h.complete(1); await bRun;
    h.render().selectBatchEdit(aId);
    expect(h.render().batchEditItems[0].requestId).toBe("request-1");
    h.unmount();
});

test("definitive rejection clears only A binding and does not change independent B", async () => {
    const h = batchHarness();
    const a = h.draft("a"), aId = a.activeBatchEditId;
    const aRun = a.runBatchImageEdit(); await settleBatch();
    h.render().createBatchEdit(); const bRun = h.draft("b").runBatchImageEdit(); await settleBatch();
    h.fail(0, new QueuedTaskHttpError(422, "disabled")); await aRun;
    expect(h.render().batchEditItems[0].requestId).toBe("request-2");
    expect(h.render().batchEditRunning).toBe(true);
    h.render().selectBatchEdit(aId);
    expect(h.render().batchEditItems[0].requestId).toBeUndefined();
    h.complete(1); await bRun; h.unmount();
});
