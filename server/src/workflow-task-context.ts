import { createHash } from "node:crypto";
import { z } from "zod";

export class WorkflowTaskPending extends Error {
  constructor(readonly nextPollMs: number) { super("工作流仍在执行，稍后查询原任务"); }
}

const contextSchema = z.object({
  version: z.literal(1),
  workflowConfigId: z.string().min(1),
  modelConfigId: z.string().min(1),
  providerId: z.string().min(1),
  configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
  pollIntervalMs: z.number().int().min(500).max(60_000),
  timeoutSeconds: z.number().int().min(30).max(7_200),
});
export type WorkflowTaskContext = z.infer<typeof contextSchema>;

type WorkflowConfiguration = {
  workflow_config_id: string | null;
  model_config_id: string | null;
  provider_id: string | null;
  model_id: string | null;
  protocol: string | null;
  base_url: string | null;
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

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  return value;
}

/** Only a digest of configurable paths/URLs/templates is persisted. Credentials,
 * signed URLs and request content never become durable protocol metadata. */
export function workflowTaskContext(task: WorkflowConfiguration): WorkflowTaskContext {
  if (!task.workflow_config_id || !task.model_config_id || !task.provider_id || !task.base_url || !task.submit_path || !task.output_path)
    throw new Error("原工作流配置不完整或已停用，不能查询或重新提交");
  const pollIntervalMs = task.poll_interval_ms ?? 2_000;
  const timeoutSeconds = task.timeout_seconds ?? 600;
  const protocol = { modelId: task.model_id, protocol: task.protocol, baseUrl: task.base_url,
    workflowId: task.workflow_id ?? null, submitPath: task.submit_path, statusPath: task.status_path ?? null,
    requestTemplate: task.request_template ?? {}, externalTaskPath: task.external_task_path ?? null,
    statusValuePath: task.status_value_path ?? null, successValues: task.success_values ?? [],
    failureValues: task.failure_values ?? [], outputPath: task.output_path, pollIntervalMs, timeoutSeconds };
  return contextSchema.parse({ version: 1, workflowConfigId: task.workflow_config_id, modelConfigId: task.model_config_id,
    providerId: task.provider_id, configurationHash: createHash("sha256").update(JSON.stringify(canonical(protocol))).digest("hex"),
    pollIntervalMs, timeoutSeconds });
}

export function assertWorkflowTaskContext(task: WorkflowConfiguration, saved: unknown): WorkflowTaskContext {
  const parsed = contextSchema.safeParse(saved);
  if (!parsed.success) throw new Error("原工作流协议记录缺失或无效；已暂停，不能重新提交生成");
  const current = workflowTaskContext(task);
  if (JSON.stringify(current) !== JSON.stringify(parsed.data))
    throw new Error("原工作流或模型渠道配置已变更；请恢复原配置后查询，不会重新提交生成");
  return parsed.data;
}
