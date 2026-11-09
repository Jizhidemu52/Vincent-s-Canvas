import { expect, test } from "bun:test";
import { batchHarness, settleBatch } from "./canvas-batch-test-harness";

test("double clicks before asynchronous preparation execute the actual batch hook only once", async () => {
    const h = batchHarness();
    const form = h.draft("a");
    const first = form.runBatchImageEdit();
    expect([...h.locks]).toEqual(["canvas-batch:" + form.activeBatchEditId]);
    await form.runBatchImageEdit();
    await settleBatch();
    expect(h.submissions).toHaveLength(1);
    expect(h.notices.some(text => text.includes("该批次仍在执行"))).toBe(true);
    h.complete(0); await first;
    expect(h.locks.size).toBe(0);
    h.unmount();
});

test("another generation lock does not block independent batch entry; failed loading releases only its own lock", async () => {
    let unavailable = true;
    const h = batchHarness({ loadFailure: () => unavailable });
    h.locks.add("shared-config");
    await h.draft("a").runBatchImageEdit();
    expect([...h.locks]).toEqual(["shared-config"]);
    expect(h.notices.some(text => text.includes("chunk unavailable"))).toBe(true);
    unavailable = false;
    const running = h.render().runBatchImageEdit(); await settleBatch();
    expect(h.submissions).toHaveLength(1);
    h.complete(0); await running;
    expect([...h.locks]).toEqual(["shared-config"]);
    h.unmount();
});
