import { expect, test } from "bun:test";
import { deleteHistoryEntries } from "@/lib/history-batch-delete";

test("batch history deletion records individual failures and settles every requested record once", async () => {
    const calls: string[] = [];
    const receipt = await deleteHistoryEntries([{ id: "a" }, { id: "b" }, { id: "a" }, { id: "c" }], async entry => {
        calls.push(entry.id);
        if (entry.id === "b") throw new Error("storage unavailable");
    });
    expect(calls).toEqual(["a", "b", "c"]);
    expect(receipt).toEqual({ deletedIds: ["a", "c"], failedIds: ["b"] });
});

test("empty and wholly failed batches never report a success", async () => {
    let calls = 0;
    const remove = async () => { calls++; throw new Error("disk full"); };
    expect(await deleteHistoryEntries([], remove)).toEqual({ deletedIds: [], failedIds: [] });
    expect(calls).toBe(0);
    expect(await deleteHistoryEntries([{ id: "a" }, { id: "b" }], remove)).toEqual({ deletedIds: [], failedIds: ["a", "b"] });
    expect(calls).toBe(2);
});
