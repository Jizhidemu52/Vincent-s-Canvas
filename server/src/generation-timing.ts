export type GenerationTimingStage =
  | "prepare"
  | "provider_request"
  | "provider_response"
  | "result_download"
  | "result_store"
  | "task_finalize"
  | "provider_execution";

export type GenerationTimingOutcome = "success" | "failed" | "paused" | "retry";

export interface GenerationTiming {
  measure<T>(stage: GenerationTimingStage, action: () => Promise<T> | T): Promise<T>;
  finish(outcome: GenerationTimingOutcome): void;
}

type TimingContext = {
  taskId: string;
  modelConfigId?: string | null;
  attempt?: number;
  runtime: "worker" | "demo";
};

/** Server-only diagnostics. No provider URLs, payloads, credentials or error text.
 * Nested stages are inclusive; provider_execution must not be added to its children.
 * A started stage without an end identifies the boundary still being awaited.
 */
export function createGenerationTiming(context: TimingContext): GenerationTiming {
  const started = performance.now();
  const identity = {
    taskId: context.taskId,
    modelConfigId: context.modelConfigId ?? null,
    attempt: context.attempt ?? 1,
    runtime: context.runtime,
  };
  let finished = false;
  const milliseconds = (start: number) => Math.round(Math.max(0, performance.now() - start) * 100) / 100;
  function emit(details: Record<string, string | number>) {
    try {
      console.log(JSON.stringify({ event: "generation_timing", ...identity, timestamp: new Date().toISOString(), elapsedMs: milliseconds(started), ...details }));
    } catch {
      // Diagnostics must never change task success, failure or resubmission behavior.
    }
  }
  return {
    async measure<T>(stage: GenerationTimingStage, action: () => Promise<T> | T): Promise<T> {
      const stageStarted = performance.now();
      emit({ phase: "start", stage });
      try {
        const result = await action();
        emit({ phase: "end", stage, status: "success", durationMs: milliseconds(stageStarted) });
        return result;
      } catch (error) {
        emit({ phase: "end", stage, status: "failed", durationMs: milliseconds(stageStarted) });
        throw error;
      }
    },
    finish(outcome: GenerationTimingOutcome) {
      if (finished) return;
      finished = true;
      emit({ phase: "complete", status: outcome });
    },
  };
}
