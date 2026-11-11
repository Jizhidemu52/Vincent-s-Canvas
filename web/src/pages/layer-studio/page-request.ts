import type { QueuedTask } from "@/services/api/generation-tasks";
import { LayerStudioApiError, type LayerStudioSubmission } from "@/services/api/layer-studio";
import { applyLayerStudioSnapshot, type LayerStudioJob } from "./page-state";

/** The durable request identity is the boundary: reload/uncertainty never enters here. */
export async function submitLayerStudioOnce(job: LayerStudioJob, dependencies: {
    persist: (job: LayerStudioJob) => Promise<void>;
    create: (submission: LayerStudioSubmission) => Promise<QueuedTask>;
    assertCurrent: () => void;
}) {
    dependencies.assertCurrent();
    await dependencies.persist(job);
    dependencies.assertCurrent();
    let accepted: LayerStudioJob;
    try { accepted = applyLayerStudioSnapshot(job, await dependencies.create(job.submission)); }
    catch (error) {
        const rejected = error instanceof LayerStudioApiError && error.rejected;
        accepted = { ...job, phase: rejected ? "failed" : "uncertain", notice: rejected ? error.message : "提交结果待核查；已保留请求编号，只查询原任务，不会重复生成。" };
    }
    dependencies.assertCurrent();
    await dependencies.persist(accepted);
    return accepted;
}
