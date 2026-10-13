import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createGenerationTiming } from "../src/generation-timing";

describe("generation stage diagnostics", () => {
  const records: Array<Record<string, unknown>> = [];
  let log: ReturnType<typeof spyOn>;
  let now: ReturnType<typeof spyOn>;
  function capture() {
    records.length = 0;
    log = spyOn(console, "log").mockImplementation((line: string) => { records.push(JSON.parse(line)); });
    let clock = 100;
    now = spyOn(performance, "now").mockImplementation(() => clock);
    return (value: number) => { clock = value; };
  }
  afterEach(() => { log?.mockRestore(); now?.mockRestore(); });

  test("records an awaited boundary before completion and returns the original result", async () => {
    const setClock = capture();
    const timing = createGenerationTiming({ taskId: "task-1", modelConfigId: "config-1", attempt: 2, runtime: "worker" });
    let resolve!: (value: string) => void;
    const pending = timing.measure("provider_request", () => new Promise<string>(done => { resolve = done; }));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: "generation_timing", taskId: "task-1", phase: "start", stage: "provider_request", elapsedMs: 0 });
    setClock(145);
    resolve("image-result");
    expect(await pending).toBe("image-result");
    expect(records[1]).toMatchObject({ phase: "end", stage: "provider_request", status: "success", durationMs: 45, elapsedMs: 45, modelConfigId: "config-1", attempt: 2 });
    timing.finish("success");
    timing.finish("failed");
    expect(records).toHaveLength(3);
    expect(records[2]).toMatchObject({ phase: "complete", status: "success", elapsedMs: 45 });
  });

  test("preserves the exact rejection without exposing secrets from errors or extra context", async () => {
    const setClock = capture();
    const context = { taskId: "task-2", runtime: "demo" as const, apiKey: "private-key", prompt: "private-prompt" };
    const timing = createGenerationTiming(context);
    const failure = new Error("https://private.example/?token=private-token");
    const pending = timing.measure("result_download", () => { setClock(120); throw failure; });
    await expect(pending).rejects.toBe(failure);
    timing.finish("failed");
    expect(records[1]).toMatchObject({ phase: "end", stage: "result_download", status: "failed", durationMs: 20 });
    const serialized = JSON.stringify(records);
    for (const sensitive of ["private-key", "private-prompt", "private-token", "private.example"]) expect(serialized).not.toContain(sensitive);
  });

  test("keeps overlapping stage durations separate and never changes work when logging fails", async () => {
    const setClock = capture();
    const timing = createGenerationTiming({ taskId: "task-3", runtime: "worker" });
    const value = await timing.measure("provider_execution", async () => {
      setClock(110);
      return timing.measure("provider_response", () => { setClock(130); return 7; });
    });
    expect(value).toBe(7);
    expect(records.filter(record => record.phase === "end").map(record => [record.stage, record.durationMs])).toEqual([["provider_response", 20], ["provider_execution", 30]]);
    log.mockImplementation(() => { throw new Error("log sink unavailable"); });
    expect(await timing.measure("result_store", () => "stored")).toBe("stored");
    expect(() => timing.finish("success")).not.toThrow();
  });
});
