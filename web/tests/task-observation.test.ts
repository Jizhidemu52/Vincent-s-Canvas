import { expect, test } from "bun:test";
import { observeTask, observationDelay, TaskObservationStoppedError } from "../src/services/api/task-observation";

test("observation expires without declaring failure or performing a mutation", async () => {
    let now = 0;
    const seen: string[] = [];
    await expect(observeTask({ taskIds: ["task"], read: async () => { seen.push("GET"); return "processing"; }, done: value => value === "success", timeoutMs: 10, intervalMs: 4, now: () => now, delay: async ms => { now += ms; } })).rejects.toMatchObject({ name: "TaskObservationStoppedError", reason: "timeout", taskIds: ["task"] });
    expect(seen).toEqual(["GET", "GET", "GET"]);
});

test("transient GET failures are retried but successful terminal results are returned", async () => {
    let calls = 0;
    const delays: number[] = [];
    expect(await observeTask({ read: async () => { if (++calls < 3) throw new Error("502"); return "success"; }, done: value => value === "success", delay: async ms => { delays.push(ms); } })).toBe("success");
    expect(delays).toEqual([2000, 4000]);
});

test("repeated query errors stop observation, never become a terminal task failure", async () => {
    let calls = 0;
    const error = await observeTask({ read: async () => { calls++; throw new Error("offline"); }, done: () => false, delay: async () => undefined }).catch(error => error);
    expect(error).toBeInstanceOf(TaskObservationStoppedError);
    expect(error.reason).toBe("unavailable");
    expect(calls).toBe(3);
});

test("abort interrupts delay and does not execute another read", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = observeTask({ signal: controller.signal, read: async () => { calls++; return "pending"; }, done: () => false });
    await Promise.resolve(); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
    await expect(observationDelay(1000, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});

test("domain-terminal and paused outcomes are not swallowed as network retries", async () => {
    let calls = 0;
    const domainError = new Error("paused");
    await expect(observeTask({ read: async () => { calls++; return "paused"; }, done: () => { throw domainError; } })).rejects.toBe(domainError);
    expect(calls).toBe(1);
});
