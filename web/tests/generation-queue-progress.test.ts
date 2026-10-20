import { expect, test } from "bun:test";
import { generationProgressText, watchGenerationProgress } from "../src/components/generation-queue-progress";
import type { QueuedTaskProgress } from "../src/services/api/generation-tasks";

const waiting: QueuedTaskProgress = {
    taskId: "current", status: "waiting", runtime: "worker", phase: "waiting",
    queuePosition: 3, estimatedWaitSeconds: 60, estimatedRemainingSeconds: 120,
    sampleCount: 3, estimateReason: null, retryAfterSeconds: null,
};

function visibilityFixture(hidden = false) {
    const events = new EventTarget();
    return { hidden, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), set(value: boolean) {
        this.hidden = value;
        events.dispatchEvent(new Event("visibilitychange"));
    } };
}
async function until(condition: () => boolean) {
    for (let index = 0; index < 100 && !condition(); index++) await Bun.sleep(2);
    expect(condition()).toBe(true);
}

test("progress text distinguishes model-ready queue, demo, estimates and unknown durations", () => {
    expect(generationProgressText(waiting)).toBe("同模型可运行队列第 3 位 · 预计排队约 1 分钟 · 预计还需约 2 分钟（仅供参考）");
    expect(generationProgressText({ ...waiting, estimatedRemainingSeconds: null })).toContain("暂无可靠耗时估算");
    expect(generationProgressText({ ...waiting, queuePosition: null, estimatedRemainingSeconds: null })).toContain("名次暂不可用");
    expect(generationProgressText({ ...waiting, runtime: "demo", phase: "processing", queuePosition: null })).toContain("本机无共享排队");
    expect(generationProgressText({ ...waiting, phase: "complete", status: "success" })).toBe("生成完成");
    expect(generationProgressText({ ...waiting, phase: "paused" })).toContain("已暂停");
});

test("poller pauses while hidden and stops on completion without changing task execution", async () => {
    const visibility = visibilityFixture(true);
    const states: QueuedTaskProgress[] = [];
    let reads = 0;
    const stop = watchGenerationProgress("current", view => { if (view.progress) states.push(view.progress); }, visibility, async () => {
        reads++;
        return reads === 1 ? waiting : { ...waiting, phase: "complete", status: "success" };
    }, 8);
    await Bun.sleep(15);
    expect(reads).toBe(0);
    visibility.set(false);
    await until(() => states.length === 2);
    await Bun.sleep(25);
    expect(reads).toBe(2);
    visibility.set(true); visibility.set(false);
    await Bun.sleep(15);
    expect(reads).toBe(2);
    stop();
});

test("cleanup aborts in-flight reads and ignores late results; pause/404 stop further reads", async () => {
    const visibility = visibilityFixture();
    let signal: AbortSignal | undefined;
    let finish!: (value: QueuedTaskProgress) => void;
    let published = 0;
    const stop = watchGenerationProgress("current", () => { published++; }, visibility, async (_id, suppliedSignal) => {
        signal = suppliedSignal;
        return new Promise(resolve => { finish = resolve; });
    }, 5);
    stop();
    expect(signal?.aborted).toBe(true);
    finish(waiting);
    await Bun.sleep(15);
    expect(published).toBe(0);
    for (const result of [null, { ...waiting, phase: "paused" as const, status: "paused" }]) {
        let reads = 0;
        const dispose = watchGenerationProgress("current", () => undefined, visibility, async () => { reads++; return result; }, 5);
        await Bun.sleep(20);
        expect(reads).toBe(1);
        dispose();
    }
});
