import { describe, expect, it } from "vitest";
import { runBatchGenerationQueue } from "./batchRunner";

async function flushQueue() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("batch generation runner", () => {
  it("runs queued batch items up to the configured concurrency while preserving outcome order", async () => {
    const started: string[] = [];
    const active: string[] = [];
    const resolvers = new Map<string, (value: string) => void>();

    const run = runBatchGenerationQueue(["front", "back", "side"], { concurrency: 2, failurePolicy: "continue" }, async (item) => {
      started.push(item);
      active.push(item);
      const value = await new Promise<string>((resolve) => resolvers.set(item, resolve));
      active.splice(active.indexOf(item), 1);
      return `${value}-done`;
    });

    expect(started).toEqual(["front", "back"]);
    expect(active).toEqual(["front", "back"]);

    resolvers.get("front")?.("front");
    await flushQueue();

    expect(started).toEqual(["front", "back", "side"]);
    expect(active).toEqual(["back", "side"]);

    resolvers.get("back")?.("back");
    resolvers.get("side")?.("side");

    await expect(run).resolves.toEqual([
      { result: "front-done" },
      { result: "back-done" },
      { result: "side-done" }
    ]);
  });

  it("stops scheduling new batch items after a failure when the policy is stop", async () => {
    const started: string[] = [];

    const outcomes = await runBatchGenerationQueue(["front", "back", "side"], { concurrency: 1, failurePolicy: "stop" }, async (item) => {
      started.push(item);
      if (item === "back") throw new Error("Provider rejected back");
      return `${item}-done`;
    });

    expect(started).toEqual(["front", "back"]);
    expect(outcomes).toEqual([
      { result: "front-done" },
      { errorMessage: "Provider rejected back" },
      { status: "cancelled", errorMessage: "Skipped after stop-on-failure" }
    ]);
  });

  it("pauses scheduling new batch items and reports pending outcomes as paused", async () => {
    const started: string[] = [];
    let paused = false;
    const resolvers = new Map<string, (value: string) => void>();

    const run = runBatchGenerationQueue(
      ["front", "back", "side"],
      { concurrency: 1, failurePolicy: "continue", shouldPause: () => paused },
      async (item) => {
        started.push(item);
        const value = await new Promise<string>((resolve) => resolvers.set(item, resolve));
        return `${value}-done`;
      }
    );

    expect(started).toEqual(["front"]);

    paused = true;
    resolvers.get("front")?.("front");

    await expect(run).resolves.toEqual([
      { result: "front-done" },
      { status: "paused", errorMessage: "Paused by designer" },
      { status: "paused", errorMessage: "Paused by designer" }
    ]);
    expect(started).toEqual(["front"]);
  });
});
