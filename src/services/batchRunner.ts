import type { BatchFailurePolicy } from "../domain/workspace";

export interface BatchRunSettings {
  concurrency: number;
  failurePolicy: BatchFailurePolicy;
}

export interface BatchRunOutcome<TResult> {
  result?: TResult;
  status?: "error" | "cancelled";
  errorMessage?: string;
}

export async function runBatchGenerationQueue<TItem, TResult>(
  items: TItem[],
  settings: BatchRunSettings,
  runItem: (item: TItem, index: number) => Promise<TResult>
): Promise<Array<BatchRunOutcome<TResult>>> {
  const concurrency = Math.max(1, Math.min(items.length || 1, Math.round(settings.concurrency || 1)));
  const outcomes: Array<BatchRunOutcome<TResult> | undefined> = Array.from({ length: items.length });
  let nextIndex = 0;
  let activeCount = 0;
  let stopped = false;

  return new Promise((resolve) => {
    const finishIfDone = () => {
      if (activeCount === 0 && (nextIndex >= items.length || stopped)) {
        if (stopped) {
          for (let index = 0; index < items.length; index += 1) {
            if (!outcomes[index]) {
              outcomes[index] = { status: "cancelled", errorMessage: "Skipped after stop-on-failure" };
            }
          }
        }
        resolve(outcomes.map((outcome) => outcome ?? { status: "cancelled", errorMessage: "Skipped after stop-on-failure" }));
      }
    };

    const schedule = () => {
      while (!stopped && activeCount < concurrency && nextIndex < items.length) {
        const currentIndex = nextIndex;
        const item = items[currentIndex];
        nextIndex += 1;
        activeCount += 1;
        runItem(item, currentIndex)
          .then((result) => {
            outcomes[currentIndex] = { result };
          })
          .catch((error) => {
            outcomes[currentIndex] = { errorMessage: error instanceof Error ? error.message : "Batch item failed" };
            if (settings.failurePolicy === "stop") {
              stopped = true;
            }
          })
          .finally(() => {
            activeCount -= 1;
            schedule();
            finishIfDone();
          });
      }
      finishIfDone();
    };

    schedule();
  });
}
