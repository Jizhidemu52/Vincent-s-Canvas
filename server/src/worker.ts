import { loadConfig } from "./config";
import { randomUUID } from "node:crypto";
import { createCache, createDatabase, type Cache, type Database } from "./db";
import { decryptSecret } from "./security";
import { settleReservation } from "./billing";
import { withTransaction } from "./db-transaction";
import { popReadyTask, scheduleQueuedTask } from "./task-queue";
import { acquireModelLease, releaseModelLease, startTaskLeaseHeartbeat, TaskExecutionLost, type TaskLease } from "./model-concurrency";
import { TASK_LEASE_SECONDS, canAutomaticallyRetryTask, queueScore, recalculateBatch, restoreWaitingTasksToQueue, type TaskPriority } from "./tasks";
import { ObjectStorage } from "./object-storage";
import {
  normalizeWorkflowOutputs,
  parsePromptVariables,
  readPath,
  renderTemplate,
} from "./workflow-runtime";
import {
  buildOpenAiAudioRequest,
  stepApiMartVideoTask,
  VideoTaskPending,
  VideoProviderFailure,
  VideoSubmissionClaimLost,
} from "./media-runtime";
import { recordAssetEvent } from "./asset-events";
import { classifyDesignDirection } from "./design-direction";
import { ApiMartImageProviderFailure, runApiMartImageTask } from "./apimart-image";
import { videoSourceMetadata, type ProviderVideoSource } from "./video-models";
import { probeMediaBytes } from "./media-probe";
import { fetchProviderSubmission, readProviderSubmissionDiagnostics } from "./provider-submission-transport";
import { ProviderSubmissionRejected, isDefinitiveSubmissionRejection, submissionWasNotSent } from "./provider-submission-policy";
import { createGenerationTiming, type GenerationTiming, type GenerationTimingOutcome } from "./generation-timing";
import { fetchProviderResult } from "./provider-result";
import { inlineProviderImageDataUrl } from "./provider-image-result";
import { assertImageEditMaskSupport, prepareImageEditInput } from "./image-edit-input";
import { imageResultExtension, storeImageResult } from "./image-result-storage";
import { scheduleAssetThumbnails } from "./asset-thumbnails";

type WorkRow = {
  id: string;
  request_id: string;
  batch_id: string | null;
  user_id: string;
  department_id: string | null;
  project_id: string;
  operation_type: string;
  model_config_id: string | null;
  prompt: string;
  parameters: Record<string, unknown>;
  source_urls: string[];
  attempts: number;
  execution_token: string;
  started_at: string | null;
  poll_deadline_at: string | null;
  upstream_task_id: string | null;
  upstream_submission_started_at: string | null;
  priority: TaskPriority;
  queued_at: string;
  model_id: string | null;
  concurrency_limit: number | null;
  protocol: string | null;
  base_url: string | null;
  encrypted_credentials: string | null;
  workflow_config_id: string | null;
  workflow_id: string | null;
  submit_path: string | null;
  status_path: string | null;
  request_template: unknown;
  external_task_path: string | null;
  status_value_path: string | null;
  success_values: string[] | null;
  failure_values: string[] | null;
  output_path: string | null;
  poll_interval_ms: number | null;
  timeout_seconds: number | null;
};

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
let cache: Cache;
const storage = new ObjectStorage(config);
let stopping = false;
let queueReconciliation: Promise<void> | null = null;
let queueReconciliationTimer: ReturnType<typeof setInterval> | undefined;
let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
const activeTaskIds = new Set<string>();

async function nextTask() {
  return popReadyTask(cache);
}

async function runTask(taskId: string) {
  const executionToken = randomUUID();
  const claimed = await db.query<WorkRow>(
    `UPDATE tasks SET status='processing',started_at=COALESCE(started_at,now()),execution_token=$3,
        lease_expires_at=now()+($2::int * interval '1 second'),updated_at=now()
        WHERE id=$1 AND available_at<=now() AND (status='waiting'
          OR (status='processing' AND execution_token IS NULL AND upstream_task_id IS NOT NULL))
        RETURNING id`,
    [taskId, TASK_LEASE_SECONDS, executionToken],
  );
  if (!claimed.rows[0]) return;
  const details = await db.query<WorkRow>(
    `SELECT t.id,t.request_id,t.batch_id,t.user_id,t.department_id,t.project_id,t.operation_type,t.model_config_id,t.prompt,t.parameters,t.source_urls,t.attempts,t.execution_token,t.started_at,t.poll_deadline_at,t.upstream_task_id,t.upstream_submission_started_at,t.priority,t.queued_at,m.model_id,m.concurrency_limit,m.workflow_config_id,p.protocol,p.base_url,p.encrypted_credentials,w.workflow_id,w.submit_path,w.status_path,w.request_template,w.external_task_path,w.status_value_path,w.success_values,w.failure_values,w.output_path,w.poll_interval_ms,w.timeout_seconds
        FROM tasks t LEFT JOIN model_configs m ON m.id=t.model_config_id LEFT JOIN providers p ON p.id=m.provider_id LEFT JOIN workflow_configs w ON w.id=m.workflow_config_id AND w.enabled=true WHERE t.id=$1 AND t.execution_token=$2`,
    [taskId, executionToken],
  );
  const task = details.rows[0];
  if (!task) return;
  let modelLease: TaskLease | null = null;
  try {
    modelLease = await acquireModelLease(db, cache, { taskId, executionToken, modelConfigId: task.model_config_id, limit: task.concurrency_limit ?? 5 });
    if (!modelLease) {
      await deferTask(task, 2_000, false);
      return;
    }
  } catch (error) {
    // Admission errors never become paid attempts. Redis/database recovery can
    // restore this durable deadline without immediately spinning on the task.
    await deferTask(task, 5_000, Boolean(task.upstream_task_id)).catch(() => undefined);
    throw error;
  }
  const heartbeat = startTaskLeaseHeartbeat(db, cache, modelLease, TASK_LEASE_SECONDS);
  const timing = createGenerationTiming({ taskId, requestId: task.request_id, modelConfigId: task.model_config_id, attempt: task.attempts + (task.upstream_submission_started_at ? 0 : 1), runtime: "worker" });
  let outcome: GenerationTimingOutcome = "failed";
  let providerProducedResult = false;
  let keepModelSlot = false;
  try {
    const attempted = await db.query<{ attempts: number }>(
      `UPDATE tasks SET attempts=attempts+CASE WHEN upstream_task_id IS NULL AND upstream_submission_started_at IS NULL THEN 1 ELSE 0 END
       WHERE id=$1 AND execution_token=$2 AND status='processing' RETURNING attempts`, [taskId, executionToken],
    );
    if (!attempted.rows[0]) throw new TaskExecutionLost("任务执行权已改变");
    task.attempts = attempted.rows[0].attempts;
    if (config.TASK_MOCK_MODE === "true" && (task.operation_type === "video_generation" || task.operation_type === "audio_generation"))
      throw new Error("模拟模式不提供真实视频或音频，请配置真实服务后生成");
    heartbeat.assertOwned();
    const providerResults =
      config.TASK_MOCK_MODE === "true"
        ? [{ bytes: Buffer.from(mockSvg(task.id)), mimeType: "image/svg+xml" }]
        : await timing.measure("provider_execution", () => executeProvider(task, timing));
    providerProducedResult = true;
    heartbeat.assertOwned();
    await assertTaskExecution(task);
    const resultUrls = await timing.measure("result_store", () => storeResults(task, providerResults));
    await timing.measure("task_finalize", async () => {
      await withTransaction(db, async client => {
        const owned = await client.query("SELECT id FROM tasks WHERE id=$1 AND execution_token=$2 AND status='processing' FOR UPDATE", [task.id, executionToken]);
        if (!owned.rows[0]) throw new TaskExecutionLost("任务执行权已改变，不能重复结算");
        await settleReservation(db, task.request_id, "capture", undefined, client);
        await client.query(
          "UPDATE tasks SET status='success',result_urls=$1,lease_expires_at=NULL,completed_at=now(),updated_at=now() WHERE id=$2",
          [JSON.stringify(resultUrls), task.id],
        );
        await client.query(
          `INSERT INTO generation_history(task_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,credits,rmb_cost,status)
                SELECT id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,credits,rmb_cost,'success' FROM tasks WHERE id=$1 ON CONFLICT(task_id) DO NOTHING`,
          [task.id],
        );
      });
    });
    outcome = "success";
  } catch (error) {
    if (error instanceof VideoTaskPending) {
      // Keep the model's upstream-inflight reservation, release only this
      // execution slot. A later short invocation queries the persisted ID.
      keepModelSlot = true;
      await deferTask(task, error.nextPollMs, true);
      outcome = "retry";
      return;
    }
    if (error instanceof VideoSubmissionClaimLost || error instanceof TaskExecutionLost) {
      keepModelSlot = true; outcome = "paused"; return;
    }
    const transportDiagnostics = readProviderSubmissionDiagnostics(error);
    const reason =
      error instanceof Error ? error.message.slice(0, 2_000) : "任务执行失败";
    if (providerProducedResult) {
      // Local processing/storage failures must not replay paid work or claim it never happened.
      await db.query(
        "UPDATE tasks SET status='paused',failure_reason=$1,lease_expires_at=NULL,updated_at=now() WHERE id=$2 AND execution_token=$3 AND status='processing'",
        [`${reason}；上游已返回结果，不能直接恢复或重新生成，请先检查已保存素材。`, task.id, executionToken],
      );
      outcome = "paused";
    } else if (task.upstream_submission_started_at && !(error instanceof VideoProviderFailure) && !(error instanceof ApiMartImageProviderFailure)
      && !(error instanceof ProviderSubmissionRejected) && !submissionWasNotSent(error)) {
      keepModelSlot = true;
      // Keep the original reservation while upstream work may still exist. Recovery only polls its persisted ID.
      await db.query(
        "UPDATE tasks SET status='paused',failure_reason=$1,lease_expires_at=NULL,updated_at=now() WHERE id=$2 AND execution_token=$3 AND status='processing'",
        [task.upstream_task_id ? `${reason}；已暂停，可恢复查询原任务，不会重新生成` : `${reason}；提交状态待核实，不会自动重新生成`, task.id, executionToken],
      );
      outcome = "paused";
    } else if (canAutomaticallyRetryTask(task.operation_type, task.upstream_submission_started_at, task.attempts)) {
      await releaseModelLease(db, cache, modelLease);
      await deferTask(task, task.attempts * 5_000, false, reason);
      outcome = "retry";
    } else {
      await withTransaction(db, async client => {
        const owned = await client.query("SELECT id FROM tasks WHERE id=$1 AND execution_token=$2 AND status='processing' FOR UPDATE", [task.id, executionToken]);
        if (!owned.rows[0]) throw new TaskExecutionLost("任务执行权已改变，不能重复退款");
        await settleReservation(db, task.request_id, "release", undefined, client);
        await client.query(
        "UPDATE tasks SET status='failed',failure_reason=$1,lease_expires_at=NULL,completed_at=now(),updated_at=now() WHERE id=$2",
        [reason, task.id],
      );
        await client.query(
        `INSERT INTO generation_history(task_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,credits,rmb_cost,status,failure_reason)
                SELECT id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,'[]',0,0,'failed',$2 FROM tasks WHERE id=$1 ON CONFLICT(task_id) DO NOTHING`,
        [task.id, reason],
      );
        await client.query(
        `INSERT INTO audit_logs(actor_user_id,action,target_type,target_id,result,detail)
                SELECT user_id,'task.failed','task',id::text,'failed',jsonb_build_object('reason',$2::text,'attempts',attempts) || $3::jsonb FROM tasks WHERE id=$1`,
        [task.id, reason, JSON.stringify(transportDiagnostics ? { transport: transportDiagnostics } : {})],
      );
      });
    }
  } finally {
    timing.finish(outcome);
    await heartbeat.stop();
    if (!keepModelSlot) await releaseModelLease(db, cache, modelLease);
    await db.query("UPDATE tasks SET execution_token=NULL WHERE id=$1 AND execution_token=$2", [task.id, executionToken]);
    if (task.batch_id) await recalculateBatch(db, task.batch_id);
  }
}

async function deferTask(task: WorkRow, milliseconds: number, polling: boolean, reason: string | null = null) {
  const changed = await db.query<{ available_at: string }>(
    `UPDATE tasks SET status=$1,available_at=clock_timestamp()+($2::int * interval '1 millisecond'),
        execution_token=NULL,lease_expires_at=NULL,failure_reason=COALESCE($3,failure_reason),updated_at=now()
     WHERE id=$4 AND execution_token=$5 AND status='processing' RETURNING available_at`,
    [polling ? "processing" : "waiting", milliseconds, reason, task.id, task.execution_token],
  );
  if (!changed.rows[0]) throw new TaskExecutionLost("任务执行权已改变，不能重新排队");
  const due = new Date(changed.rows[0].available_at).getTime();
  await scheduleQueuedTask(cache, task.id, queueScore(task.priority, new Date(task.queued_at).getTime()), due);
}

async function assertTaskExecution(task: WorkRow) {
  const current = await db.query("SELECT id FROM tasks WHERE id=$1 AND execution_token=$2 AND status='processing' AND lease_expires_at>now()", [task.id, task.execution_token]);
  if (!current.rows[0]) throw new TaskExecutionLost("任务执行租约已失效");
}

async function claimProviderSubmission(task: WorkRow) {
  if (task.upstream_submission_started_at || task.upstream_task_id) throw new Error("原任务已提交或结果未知，不能重复提交付费请求");
  const claimed = await db.query(
    "UPDATE tasks SET upstream_submission_started_at=now(),updated_at=now() WHERE id=$1 AND execution_token=$2 AND lease_expires_at>now() AND status='processing' AND upstream_submission_started_at IS NULL AND upstream_task_id IS NULL RETURNING id",
    [task.id, task.execution_token],
  );
  if (!claimed.rows[0]) throw new VideoSubmissionClaimLost("任务提交权已改变，不会重新生成");
  task.upstream_submission_started_at = new Date().toISOString();
}

async function assertProviderSubmissionResponse(response: Response, label: string) {
  if (response.ok) return;
  await response.body?.cancel().catch(() => undefined);
  const message = `${label}请求失败（HTTP ${response.status}）`;
  throw isDefinitiveSubmissionRejection(response.status) ? new ProviderSubmissionRejected(message) : new Error(message);
}

import { openAiImageParameters } from "./openai-image-parameters";
import { OPENAI_IMAGE_TIMEOUT_MS } from "./opentoken-image";

async function executeProvider(task: WorkRow, timing: GenerationTiming) {
  // Existing async image submissions must never fall through to a newly edited
  // synchronous provider/workflow configuration and create another paid job.
  if (task.operation_type !== "video_generation" && (task.upstream_task_id || task.upstream_submission_started_at)
    && (task.protocol !== "apimart" || task.workflow_config_id)) {
    throw new Error("原图片任务已提交，但模型渠道配置已变更；请恢复原 APIMart 渠道后查询，不能重新提交生成");
  }
  if (!task.protocol || !task.base_url || !task.model_id)
    throw new Error("任务模型或 Provider 未配置");
  assertImageEditMaskSupport(task.parameters, { protocol: task.protocol, modelId: task.model_id, operationType: task.operation_type, workflow: Boolean(task.workflow_config_id) }, task.source_urls.length);
  if (!task.encrypted_credentials || !config.PROVIDER_ENCRYPTION_KEY)
    throw new Error("Provider 服务端凭据未配置");
  const credentials = JSON.parse(
    decryptSecret(task.encrypted_credentials, config.PROVIDER_ENCRYPTION_KEY),
  ) as Record<string, string>;
  if (task.operation_type === "video_generation") {
    if (task.protocol !== "apimart") throw new Error("当前视频执行器仅支持已配置的 APIMart 视频模型，请检查 Provider 协议");
    return executeApiMartVideo(task, credentials);
  }
  if (task.workflow_config_id && task.submit_path && task.output_path)
    return executeWorkflow(task, credentials);
  if (task.protocol === "apimart")
    return executeApiMartImage(task, credentials);
  const authorization: Record<string, string> = credentials.apiKey
    ? { authorization: `Bearer ${credentials.apiKey}` }
    : {};
  if (task.protocol === "openai" && task.operation_type === "audio_generation")
    return executeOpenAiAudio(task, authorization);
  let response: Response;
  if (
    task.protocol === "openai" &&
    task.source_urls.length
  ) {
    const form = new FormData();
    form.set("model", task.model_id);
    form.set("prompt", task.prompt);
    form.set("n", "1");
    if (!task.model_id.startsWith("gpt-image-")) form.set("response_format", "b64_json");
    for (const [key, value] of Object.entries(openAiImageParameters(task.parameters, task.model_id))) form.set(key, String(value));
    const sourceAssets = await timing.measure("prepare", () => loadSourceAssets(task.source_urls, task.user_id));
    const editInput = await timing.measure("prepare", () => prepareImageEditInput(sourceAssets, task.parameters, { protocol: task.protocol!, modelId: task.model_id!, operationType: task.operation_type }));
    for (const [index, source] of editInput.references.entries()) {
      form.append(
        "image",
        new Blob([Uint8Array.from(source.bytes).buffer], {
          type: source.mimeType,
        }),
        source.filename || `reference-${index + 1}.png`,
      );
    }
    if (editInput.mask) form.set("mask", new Blob([Uint8Array.from(editInput.mask.bytes).buffer], { type: editInput.mask.mimeType }), editInput.mask.filename || "mask.png");
    await claimProviderSubmission(task);
    response = await timing.measure("provider_request", () => fetchProviderSubmission(`${task.base_url!.replace(/\/$/, "")}/images/edits`, {
      method: "POST",
      headers: authorization,
      body: form,
      signal: AbortSignal.timeout(OPENAI_IMAGE_TIMEOUT_MS),
    }));
  } else {
    const endpoint =
      task.protocol === "openai"
        ? `${task.base_url.replace(/\/$/, "")}/images/generations`
        : task.base_url;
    const payload =
      task.protocol === "openai"
        ? {
            model: task.model_id,
            prompt: task.prompt,
            n: 1,
            ...(!task.model_id.startsWith("gpt-image-") ? { response_format: "b64_json" } : {}),
            ...openAiImageParameters(task.parameters, task.model_id),
          }
        : {
            model: task.model_id,
            prompt: task.prompt,
            sourceUrls: task.source_urls,
            credentials: Object.fromEntries(
              Object.entries(credentials).filter(([key]) => key !== "apiKey"),
            ),
          };
    const requestBody = JSON.stringify(payload);
    await claimProviderSubmission(task);
    response = await timing.measure("provider_request", () => fetchProviderSubmission(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...authorization },
      body: requestBody,
      signal: AbortSignal.timeout(180_000),
    }));
  }
  const body = (await timing.measure("provider_response", async () => {
    await assertProviderSubmissionResponse(response, "图片 Provider");
    return response.json();
  })) as {
    data?: Array<{ url?: string; b64_json?: string }>;
    resultUrls?: string[];
    url?: string;
  };
  const outputFormat = task.protocol === "openai" ? openAiImageParameters(task.parameters, task.model_id).output_format || "png" : "png";
  const urls =
    body.resultUrls ??
    body.data
      ?.map(
        (item) =>
          item.url ||
          (item.b64_json ? inlineProviderImageDataUrl(item.b64_json, `image/${outputFormat}`) : ""),
      )
      .filter(Boolean) ??
    (body.url ? [body.url] : []);
  if (!urls.length) throw new Error("Provider 未返回图片结果");
  return Promise.all(urls.map(url => fetchProviderResult(url, timing)));
}

async function executeApiMartImage(
  task: WorkRow,
  credentials: Record<string, string>,
) {
  const sourceAssets = task.upstream_task_id || task.upstream_submission_started_at ? [] : await loadSourceAssets(task.source_urls, task.user_id);
  const editInput = sourceAssets.length ? await prepareImageEditInput(sourceAssets, task.parameters, {
    protocol: "apimart", modelId: task.model_id!, operationType: task.operation_type,
  }) : { references: sourceAssets };
  const outputUrls = await runApiMartImageTask({
    baseUrl: task.base_url!,
    apiKey: credentials.apiKey || "",
    modelId: task.model_id!,
    submissionKey: task.id,
    prompt: task.prompt,
    parameters: task.parameters,
    sourceDataUrls: editInput.references.map((asset) => `data:${asset.mimeType};base64,${Buffer.from(asset.bytes).toString("base64")}`),
    ...(editInput.mask ? { maskDataUrl: `data:image/png;base64,${Buffer.from(editInput.mask.bytes).toString("base64")}` } : {}),
    upstreamTaskId: task.upstream_task_id,
    submissionStarted: Boolean(task.upstream_submission_started_at),
    beforeSubmit: async () => {
      const claimed = await db.query("UPDATE tasks SET upstream_submission_started_at=now(),updated_at=now() WHERE id=$1 AND execution_token=$2 AND lease_expires_at>now() AND status='processing' AND upstream_submission_started_at IS NULL RETURNING id", [task.id, task.execution_token]);
      if (!claimed.rows[0]) throw new VideoSubmissionClaimLost();
      task.upstream_submission_started_at = new Date().toISOString();
    },
    onSubmitted: async (id) => {
      task.upstream_task_id = id;
      const persisted = await db.query("UPDATE tasks SET upstream_task_id=$1,updated_at=now() WHERE id=$2 AND (upstream_task_id IS NULL OR upstream_task_id=$1) RETURNING id", [id, task.id]);
      if (!persisted.rows[0]) throw new VideoSubmissionClaimLost("原上游任务身份已改变");
    },
  });
  return Promise.all(outputUrls.map(url => fetchProviderResult(url)));
}

async function executeOpenAiAudio(
  task: WorkRow,
  authorization: Record<string, string>,
) {
  const request = buildOpenAiAudioRequest(
    task.model_id!,
    task.prompt,
    task.parameters,
  );
  const requestBody = JSON.stringify(request.payload);
  await claimProviderSubmission(task);
  const response = await fetch(
    `${task.base_url!.replace(/\/$/, "")}/audio/speech`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authorization },
      body: requestBody,
      signal: AbortSignal.timeout(180_000),
    },
  );
  await assertProviderSubmissionResponse(response, "音频 Provider");
  return [
    {
      bytes: Buffer.from(await response.arrayBuffer()),
      mimeType:
        response.headers.get("content-type")?.split(";")[0] || request.mimeType,
    },
  ];
}

async function executeApiMartVideo(task: WorkRow, credentials: Record<string, string>) {
  if (!storage.configured) throw new Error("公司对象存储尚未配置，不能保存生成视频");
  if (task.upstream_task_id && task.poll_deadline_at && new Date(task.poll_deadline_at).getTime() <= Date.now()) {
    throw new Error("视频状态查询超时；可恢复查询原任务，不会重新生成");
  }
  const sources = task.upstream_task_id || task.upstream_submission_started_at ? [] : await loadSourceAssets(task.source_urls, task.user_id);
  const providerSources: ProviderVideoSource[] = [];
  for (const source of sources) {
    providerSources.push({ ...source, ...await probeMediaBytes(source.bytes, source.mimeType), publicUrl: source.mimeType.startsWith("image/") ? undefined : await storage.signedDownloadUrl(source.objectKey, 1800) });
  }
  const result = await stepApiMartVideoTask({
    baseUrl: task.base_url!, apiKey: credentials.apiKey || "", modelId: task.model_id!, prompt: task.prompt,
    parameters: task.parameters, sources: providerSources, upstreamTaskId: task.upstream_task_id,
    submissionStarted: Boolean(task.upstream_submission_started_at),
    beforeSubmit: async () => {
      const claimed = await db.query(
        "UPDATE tasks SET upstream_submission_started_at=now(),updated_at=now() WHERE id=$1 AND execution_token=$2 AND lease_expires_at>now() AND status='processing' AND upstream_submission_started_at IS NULL RETURNING id",
        [task.id, task.execution_token],
      );
      if (claimed.rows[0]) task.upstream_submission_started_at = new Date().toISOString();
      return Boolean(claimed.rows[0]);
    },
    onSubmitted: async (id) => {
      task.upstream_task_id = id;
      // Even a stale execution may persist the one already-submitted identity;
      // it may never replace a different ID or submit another generation.
      const persisted = await db.query("UPDATE tasks SET upstream_task_id=$1,poll_deadline_at=COALESCE(poll_deadline_at,now()+interval '20 minutes'),updated_at=now() WHERE id=$2 AND (upstream_task_id IS NULL OR upstream_task_id=$1) RETURNING id", [id, task.id]);
      if (!persisted.rows[0]) throw new VideoSubmissionClaimLost("原上游任务身份已改变");
    },
  });
  if (result.status === "pending") throw new VideoTaskPending();
  const response = await fetch(result.url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`视频下载失败（${response.status}）`);
  const contentType = response.headers.get("content-type")?.split(";")[0] || "video/mp4";
  const mimeType = contentType === "application/octet-stream" ? "video/mp4" : contentType;
  if (!mimeType.startsWith("video/")) throw new Error("上游返回的不是视频文件");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.byteLength) throw new Error("视频结果为空");
  return [{ bytes, mimeType }];
}

async function executeWorkflow(
  task: WorkRow,
  credentials: Record<string, string>,
) {
  const sourceAssets = await loadSourceAssets(task.source_urls, task.user_id);
  if (
    (task.model_id === "gpt-image-2" || task.model_id === "gpt-image-2-ext") &&
    sourceAssets.length > 16
  ) {
    throw new Error("GPT-Image-2 supports at most 16 reference images");
  }
  const sourceImagesBase64 = sourceAssets.map((asset) =>
    Buffer.from(asset.bytes).toString("base64"),
  );
  const sourceDataUrls = sourceAssets.map(
    (asset, index) =>
      `data:${asset.mimeType || "image/png"};base64,${sourceImagesBase64[index]}`,
  );
  const requestedCount = Number(
    task.parameters.count ?? task.parameters.quantity ?? 1,
  );
  const requestedResolution = String(
    task.parameters.resolution ?? "1k",
  ).toLowerCase();
  const { inputArchive: _inputArchive, ...providerParameters } = task.parameters;
  const variables: Record<string, unknown> = {
    taskId: task.id,
    prompt: task.prompt,
    ...providerParameters,
    ...parsePromptVariables(task.prompt),
    count:
      Number.isInteger(requestedCount) &&
      requestedCount >= 1 &&
      requestedCount <= 10
        ? requestedCount
        : 1,
    size:
      typeof task.parameters.size === "string" && task.parameters.size
        ? task.parameters.size
        : "1:1",
    resolution: ["1k", "2k", "4k"].includes(requestedResolution)
      ? requestedResolution
      : "1k",
    sourceUrls: task.source_urls,
    sourceBase64: sourceImagesBase64[0] ?? "",
    sourceImagesBase64,
    sourceDataUrls,
    workflowId: task.workflow_id,
    modelId: task.model_id,
    ...credentials,
    // User JSON prompts and credential/template variables cannot override image cardinality.
    ...(isImageWorkflowTask(task) ? { n: 1, count: 1, quantity: 1 } : {}),
  };
  const body = singleImageWorkflowRequestBody(task, renderTemplate(task.request_template ?? {}, variables));
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (credentials.apiKey) {
    headers.authorization = `Bearer ${credentials.apiKey}`;
    headers["x-api-key"] = credentials.apiKey;
  }
  if (credentials.walletApiKey)
    headers["wallet-api-key"] = credentials.walletApiKey;
  const requestBody = JSON.stringify(body);
  await claimProviderSubmission(task);
  const submit = await fetch(joinUrl(task.base_url!, task.submit_path!), {
    method: "POST",
    headers,
    body: requestBody,
    signal: AbortSignal.timeout(180_000),
  });
  await assertProviderSubmissionResponse(submit, "工作流");
  let payload = (await submit.json()) as unknown;
  let outputs = normalizeWorkflowOutputs(readPath(payload, task.output_path!));
  if (outputs.length) return Promise.all(outputs.map(url => fetchProviderResult(url)));
  const externalId = task.external_task_path
    ? readPath(payload, task.external_task_path)
    : null;
  if (!externalId || !task.status_path)
    throw new Error("工作流响应中没有任务 ID 或直接结果");
  const deadline = Date.now() + (task.timeout_seconds ?? 600) * 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(task.poll_interval_ms ?? 2000);
    const statusResponse = await fetch(
      joinUrl(
        task.base_url!,
        task.status_path.replace(
          "{taskId}",
          encodeURIComponent(String(externalId)),
        ),
      ),
      { headers, signal: AbortSignal.timeout(60_000) },
    );
    if (!statusResponse.ok)
      throw new Error(`工作流状态查询失败 ${statusResponse.status}`);
    payload = await statusResponse.json();
    outputs = normalizeWorkflowOutputs(readPath(payload, task.output_path!));
    if (outputs.length) return Promise.all(outputs.map(url => fetchProviderResult(url)));
    const state = String(
      task.status_value_path ? readPath(payload, task.status_value_path) : "",
    ).toLowerCase();
    if (
      (task.failure_values ?? [])
        .map((value) => value.toLowerCase())
        .includes(state)
    )
      throw new Error(`工作流执行失败：${state}`);
    if (
      (task.success_values ?? [])
        .map((value) => value.toLowerCase())
        .includes(state)
    )
      throw new Error("工作流已完成但没有返回结果地址");
  }
  throw new Error("工作流执行超时");
}

function isImageWorkflowTask(task: Pick<WorkRow, "operation_type">) {
  return ["image_generation", "inpaint", "upscale", "batch_image", "seamless_stitch"].includes(task.operation_type);
}

function isBuiltinSingleImageWorkflow(task: WorkRow) {
  // This company protocol processes one input_image and has no output-count parameter.
  // Match the complete shipped template, not just a spoofable model name.
  const expected: Record<string, unknown> = {
    model_code: "sflxjj", task_id: "$taskId", app_key: "$appKey", input_image: "$sourceBase64",
    cut_width: "$cutWidth", redraw_width: "$redrawWidth", blur_amount: "$blurAmount",
    redraw_strength: "$redrawStrength", steps: "$steps",
  };
  const template = task.request_template;
  return task.operation_type === "seamless_stitch" && task.model_id === "sflxjj" && task.protocol === "custom"
    && task.output_path === "data.data.list" && template !== null && typeof template === "object" && !Array.isArray(template)
    && Object.keys(template).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => (template as Record<string, unknown>)[key] === value);
}

function singleImageWorkflowRequestBody(task: WorkRow, rendered: unknown): unknown {
  if (!isImageWorkflowTask(task)) return rendered;
  const unsafe = () => new Error("图片工作流未满足单张输出契约，尚未提交生成；请管理员将模板设为明确的 n/count/quantity=1，并移除多图、重复或无法确认输出数量的工作流配置");
  if (!rendered || typeof rendered !== "object" || Array.isArray(rendered)) throw unsafe();
  if (isBuiltinSingleImageWorkflow(task)) return rendered;
  if (task.model_id === "sflxjj") throw unsafe();
  const body = { ...rendered } as Record<string, unknown>;
  const counters = ["n", "count", "quantity"];
  const positiveInteger = (value: unknown) => typeof value === "number" ? Number.isSafeInteger(value) && value >= 1
    : typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
  if (!counters.some(key => Object.hasOwn(body, key))) throw unsafe();
  for (const key of counters) {
    if (!Object.hasOwn(body, key)) continue;
    if (!positiveInteger(body[key])) throw unsafe();
    body[key] = typeof body[key] === "string" ? "1" : 1;
  }
  // Opaque graphs can branch into several generation nodes even with a root n=1.
  // They need a verified single-image adapter, not a guessed count rewrite.
  for (const key of ["workflowId", "workflow_id", "workflow", "graph", "nodes", "nodeInfoList", "node_info_list"]) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== "") throw unsafe();
  }
  const outputCounters = new Set(["n", "count", "quantity", "numimages", "numoutputs", "outputcount", "imagecount", "batchsize", "batchcount"]);
  const check = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) check(item); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.replace(/[_-]/g, "").toLowerCase();
      // These are descriptive/algorithm settings, not output cardinality.
      if (["metadata", "seed", "seeds", "steps"].includes(normalized)) continue;
      if (outputCounters.has(normalized) && (!positiveInteger(item) || Number(item) !== 1)) throw unsafe();
      if (normalized === "repeat" && item !== 1 && item !== "1") throw unsafe();
      if (["requests", "tasks", "jobs", "batch"].includes(normalized) && Array.isArray(item) && item.length > 1) throw unsafe();
      if (["prompt", "extra"].includes(normalized)) {
        if (typeof item !== "string" || /--(?:repeat|r)(?=$|[\s=:\d])/i.test(item)) throw unsafe();
      }
      check(item);
    }
  };
  check(body);
  return body;
}

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

type SourceAsset = ProviderVideoSource & {
  objectKey: string;
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
};

async function loadSourceAssets(urls: string[], userId: string, concurrency = 4): Promise<SourceAsset[]> {
  const assets: SourceAsset[] = [];
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < urls.length) {
      const index = nextIndex++;
      assets[index] = await loadSourceAsset(urls[index]!, userId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), urls.length) }, worker));
  return assets;
}

async function loadSourceAsset(url: string, userId: string): Promise<SourceAsset> {
  const match = url.match(/^\/api\/assets\/([0-9a-f-]{36})\/content$/i);
  if (!match) throw new Error("参考图不是公司素材地址");
  const result = await db.query<{
    object_key: string;
    mime_type: string;
    filename: string;
    metadata?: Record<string, unknown>;
  }>(
    "SELECT object_key,mime_type,filename,metadata FROM assets WHERE id=$1 AND owner_user_id=$2 AND status='ready' AND deleted_at IS NULL",
    [match[1], userId],
  );
  const asset = result.rows[0];
  if (!asset) throw new Error("参考图不存在或无权访问");
  const object = await storage.get(asset.object_key);
  return {
    objectKey: asset.object_key,
    bytes: await object.Body!.transformToByteArray(),
    mimeType: asset.mime_type,
    filename: asset.filename,
    ...videoSourceMetadata(asset.metadata),
  };
}

async function storeResults(
  task: WorkRow,
  results: Array<{ bytes: Uint8Array; mimeType: string }>,
) {
  if (!storage.configured)
    throw new Error("公司对象存储尚未配置，不能保存生成结果");
  const urls: string[] = [];
  for (const [index, result] of results.entries()) {
    if (["image/png", "image/jpeg", "image/webp"].includes(result.mimeType)) {
      const primary = await storeImageResult({
        result, parameters: task.parameters, resultIndex: index,
        prepareEditInput: async () => {
          const archive = task.parameters.inputArchive as Record<string, unknown> | undefined;
          if (archive?.maskReferenceIndex === undefined) return { references: [] };
          return prepareImageEditInput(await loadSourceAssets(task.source_urls, task.user_id), task.parameters,
            { protocol: task.protocol!, modelId: task.model_id!, operationType: task.operation_type });
        },
        save: async (role, image, metadata) => saveResultAsset(task, index, image, role, metadata),
        updateMetadata: async (asset, metadata) => {
            await assertTaskExecution(task);
          await db.query("UPDATE assets SET metadata=COALESCE(metadata,'{}'::jsonb) || $1::jsonb,updated_at=now() WHERE id=$2 AND owner_user_id=$3", [JSON.stringify(metadata), asset.assetId, task.user_id]);
        },
      });
      await recordAssetEvent(db, {
        assetId: primary.assetId, actor: null, eventType: "asset.generated",
        idempotencyKey: `task:${task.id}:asset:${primary.assetId}:generated`,
        metadata: { resultIndex: index, operationType: task.operation_type },
      });
        scheduleAssetThumbnails(db, storage, primary.assetId);
      urls.push(`/api/assets/${primary.assetId}/content`);
      continue;
    }
    const asset = await saveResultAsset(task, index, result, "primary", {});
    await recordAssetEvent(db, {
      assetId: asset.assetId, actor: null, eventType: "asset.generated",
      idempotencyKey: `task:${task.id}:asset:${asset.assetId}:generated`,
      metadata: { resultIndex: index, operationType: task.operation_type },
    });
    urls.push(`/api/assets/${asset.assetId}/content`);
  }
  return urls;
}

async function saveResultAsset(task: WorkRow, index: number, result: { bytes: Uint8Array; mimeType: string }, role: string, metadata: Record<string, unknown>) {
      await assertTaskExecution(task);
    const id = randomUUID();
    const extension =
      result.mimeType.startsWith("image/")
        ? imageResultExtension(result.mimeType)
          : result.mimeType.includes("webm")
            ? "webm"
            : result.mimeType.startsWith("video/")
              ? "mp4"
              : result.mimeType.includes("wav")
                ? "wav"
                : result.mimeType.includes("aac")
                  ? "aac"
                  : result.mimeType.includes("ogg")
                    ? "ogg"
                    : result.mimeType.startsWith("audio/")
                      ? "mp3"
                      : "png";
    const filename = `task-${task.id}-${index + 1}${role === "primary" ? "" : `-${role}`}.${extension}`;
    const key = `users/${task.user_id}/generated/${task.id}/${filename}`;
    await storage.put(key, result.bytes, result.mimeType);
    const kind = result.mimeType.startsWith("video/")
      ? "video"
      : result.mimeType.startsWith("audio/")
        ? "other"
        : "image";
    const direction = classifyDesignDirection({
      operationType: task.operation_type,
      prompt: task.prompt,
      tool: task.parameters.tool,
    });
    const asset = await db.query<{ id: string }>(
      `INSERT INTO assets(id,owner_user_id,department_id,project_external_id,task_id,object_key,filename,mime_type,byte_size,kind,source,operation_type,prompt,model_config_id,status,primary_direction,secondary_directions,direction_rule_version,direction_evidence,metadata)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'ready',$15,$16,$17,$18,$19)
            ON CONFLICT(object_key) DO UPDATE SET status='ready',byte_size=EXCLUDED.byte_size,mime_type=EXCLUDED.mime_type,
              primary_direction=EXCLUDED.primary_direction,secondary_directions=EXCLUDED.secondary_directions,
              direction_rule_version=EXCLUDED.direction_rule_version,direction_evidence=EXCLUDED.direction_evidence,metadata=EXCLUDED.metadata,updated_at=now()
            RETURNING id`,
      [
        id,
        task.user_id,
        task.department_id,
        task.project_id,
        task.id,
        key,
        filename,
        result.mimeType,
        result.bytes.byteLength,
        kind,
        task.operation_type === "image_generation" ||
        task.operation_type === "video_generation" ||
        task.operation_type === "audio_generation"
          ? "generation"
          : "edit",
        task.operation_type,
        task.prompt,
        task.model_config_id,
        direction.primaryDirection,
        JSON.stringify(direction.secondaryDirections),
        direction.ruleVersion,
        JSON.stringify(direction.evidence),
        JSON.stringify(metadata),
      ],
    );
    return { assetId: asset.rows[0]!.id, mimeType: result.mimeType, filename };
}

function mockSvg(id: string) {
  const hue = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="hsl(${hue} 65% 46%)"/><circle cx="512" cy="440" r="260" fill="white" opacity=".7"/><text x="512" y="900" text-anchor="middle" font-family="sans-serif" font-size="40" fill="white">Wireless Canvas QA ${id.slice(0, 8)}</text></svg>`;
}

async function workerLoop() {
  let claimFailures = 0;
  while (!stopping) {
    let taskId: string | null;
    try {
      taskId = await nextTask();
      claimFailures = 0;
    } catch {
      const retryMs = Math.min(30_000, 500 * 2 ** Math.min(claimFailures++, 6));
      console.error(JSON.stringify({ event: "worker.queue_claim_failed", retryMs }));
      if (!stopping) await Bun.sleep(retryMs);
      continue;
    }
    // A signal may arrive while Redis is returning. PostgreSQL retains popped
    // but unclaimed tasks for reconciliation on the next healthy worker.
    if (stopping) break;
    if (!taskId) {
      await Bun.sleep(500);
      continue;
    }
    activeTaskIds.add(taskId);
    try {
      await runTask(taskId);
    } catch {
      console.error(JSON.stringify({ event: "worker.task_execution_error", taskId }));
    } finally {
      activeTaskIds.delete(taskId);
    }
  }
}

async function reconcileTaskQueue() {
  if (stopping || queueReconciliation) return;
  queueReconciliation = (async () => {
    try {
      const recovered = await restoreWaitingTasksToQueue(db, cache);
      if (recovered) console.log(JSON.stringify({ event: "worker.queue_reconciled", recovered }));
    } catch {
      console.error(JSON.stringify({ event: "worker.queue_reconciliation_failed" }));
    }
  })();
  try { await queueReconciliation; } finally { queueReconciliation = null; }
}

function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  clearInterval(queueReconciliationTimer);
  console.log(JSON.stringify({ event: "worker.draining", signal, activeTasks: activeTaskIds.size, graceSeconds: config.WORKER_SHUTDOWN_GRACE_SECONDS }));
  // Do not clear leases, refund, or abort submitted work. Active tasks retain
  // their heartbeat until normal completion; after the limit recovery uses the
  // durable submission marker/ID, never a replayed paid POST.
  shutdownTimer = setTimeout(() => {
    console.error(JSON.stringify({ event: "worker.drain_timeout", activeTasks: activeTaskIds.size }));
    process.exit(1);
  }, config.WORKER_SHUTDOWN_GRACE_SECONDS * 1000);
  shutdownTimer.unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
cache = await createCache(config.REDIS_URL);
await reconcileTaskQueue();
console.log(JSON.stringify({ event: "worker.started", concurrency: config.WORKER_CONCURRENCY }));
if (!stopping) queueReconciliationTimer = setInterval(() => void reconcileTaskQueue(), 60_000);
const workers = Array.from({ length: config.WORKER_CONCURRENCY }, () =>
  workerLoop(),
);
await Promise.all(workers);
await queueReconciliation;
await Promise.allSettled([db.end(), cache.quit()]);
clearTimeout(shutdownTimer);
console.log(JSON.stringify({ event: "worker.stopped" }));
