import { afterEach, expect, test } from "bun:test";
import { queryClient } from "../src/lib/query-client";
import { useUserStore } from "../src/stores/use-user-store";
import { readTaskSnapshot } from "../src/services/api/task-snapshot-query";

const original = useUserStore.getState();
afterEach(() => { queryClient.removeQueries({ queryKey: ["task-snapshot"] }); useUserStore.setState(original); });

test("shared task reads deduplicate HTTP while observer cancellation stays local", async () => {
    let calls = 0;
    const deferred = Promise.withResolvers<string[]>();
    const read = async () => { calls++; return deferred.promise; };
    const firstController = new AbortController();
    const first = readTaskSnapshot(["two", "one"], read, firstController.signal);
    const second = readTaskSnapshot(["one", "two"], read, new AbortController().signal);
    expect(calls).toBe(1);
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    deferred.resolve(["complete"]);
    expect(await second).toEqual(["complete"]);
    expect(calls).toBe(1);
});

test("notification refreshes never reuse a previously completed snapshot", async () => {
    let calls = 0;
    const read = async () => ++calls;
    expect(await readTaskSnapshot(["one"], read, new AbortController().signal)).toBe(1);
    expect(await readTaskSnapshot(["one"], read, new AbortController().signal)).toBe(2);
});

test("switching employees cancels and clears old task snapshots", async () => {
    useUserStore.setState({ user: { id: "employee-a" } as never });
    const deferred = Promise.withResolvers<string[]>();
    const pending = readTaskSnapshot(["one"], () => deferred.promise, new AbortController().signal);
    useUserStore.setState({ user: { id: "employee-b" } as never });
    await expect(pending).rejects.toBeDefined();
    deferred.resolve(["employee-a-result"]);
    await Bun.sleep(1);
    expect(queryClient.getQueryCache().findAll({ queryKey: ["task-snapshot"] })).toHaveLength(0);
});
