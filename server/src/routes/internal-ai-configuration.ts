import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { AppConfig } from "../config";
import type { Database } from "../db";
import { requireRole } from "../rbac";
import { decryptSecret, encryptSecret } from "../security";
import type { AuthenticatedRequest } from "../types";
import { normalizeWorkflowOutputs, readPath } from "../workflow-runtime";

const PROVIDER_NAME = "内部 AI";
const WORKFLOW_NAME = "无缝拼接";
const MODEL_ID = "sflxjj";
const WORKFLOW_OUTPUT_PATH = "data.data.list";
const TEST_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAJdSURBVHhe7daxbRgwEARBtab+XJ0rcQcyGBwgLwaGCvhgksdewogff359ftXv/1Bf2o360m7Ul3bT9h6gh0fDUV/ajfrSbtSXdtP2HqCHR8NRX9qN+tJu1Jd20/bjJ9F36ku7UV/ajfrSbtreA/TwaDjqS7tRX9qN+tJu2t4D9PBoOOpLu1Ff2o360m7a3gP08Gg46ku7UV/ajfrSbtreP6CHR8NRX9qN+tJu1Jd20/YeoIdHw1Ff2o360m7Ul3bT9h6gh0fDUV/ajfrSbtSXdtP2HqCHR8NRX9qN+tJu1Jd20/Ye4CfRd+pLu1Ff2o360m7a3gP08Gg46ku7UV/ajfrSbtreA/TwaDjqS7tRX9qN+tJu2t4/oIdHw1Ff2o360m7Ul3bT9h6gh0fDUV/ajfrSbtSXdtP2HqCHR8NRX9qN+tJu1Jd20/YeoIdHw1Ff2o360m7Ul3bT9h7gJ9F36ku7UV/ajfrSbtreA/TwaDjqS7tRX9qN+tJu2t4D9PBoOOpLu1Ff2o360m7a3gP08Gg46ku7UV/ajfrSbtreP6CHR8NRX9qN+tJu1Jd20/YeoIdHw1Ff2o360m7Ul3bT9h6gh0fDUV/ajfrSbtSXdtP2HuAn0XfqS7tRX9qN+tJu2t4D9PBoOOpLu1Ff2o360m7a3gP08Gg46ku7UV/ajfrSbtreA/TwaDjqS7tRX9qN+tJu2t4/oIdHw1Ff2o360m7Ul3bT9h6gh0fDUV/ajfrSbtSXdtP2HqCHR8NRX9qN+tJu1Jd20/YeoIdHw1Ff2o360m7Ul3bT9h7gJ9F36ku7UV/ajfrSbtreA/TwaDjqS7tRX9qN+tJu2t4D9PBoOOpLu1Ff2o360m7a3gP08Gg46ku7UV/ajfrSbtreP6CHR8NRX9qN+tJu1Jd20/YeoIdHw1Ff2o360m7Ul3bzb/v59RdKUNY3YGxaTQAAAABJRU5ErkJggg==";

export const internalAiSeamlessDefaults = {
  cutWidth: 200,
  redrawWidth: 200,
  blurAmount: 100,
  redrawStrength: 1,
  steps: 12,
} as const;
const configInput = z.object({
  seamlessUrl: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//i.test(value), "接口地址必须使用 HTTP 或 HTTPS"),
  appKey: z.string().trim().min(1).max(10_000).optional(),
  clearAppKey: z.boolean().optional(),
});

type ProviderRow = {
  id: string;
  base_url: string;
  encrypted_credentials: string | null;
  updated_at: string;
};

export function createInternalAiConfigurationRouter(
  db: Database,
  config: AppConfig,
) {
  const router = Router();
  router.use(requireRole("super_admin"));

  router.get("/", async (_request, response, next) => {
    try {
      response.json(await readPublicConfig(db, config));
    } catch (error) {
      next(error);
    }
  });

  router.put("/", async (request, response, next) => {
    const client = await db.connect();
    try {
      if (!config.PROVIDER_ENCRYPTION_KEY) {
        response
          .status(503)
          .json({
            error: "SECRET_KEY_NOT_CONFIGURED",
            message: "服务端尚未配置 Provider 凭据加密密钥",
          });
        return;
      }
      const input = configInput.parse(request.body);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const endpoint = splitInternalAiUrl(input.seamlessUrl);
      await client.query("BEGIN");
      const current = await client.query<ProviderRow>(
        "SELECT id,base_url,encrypted_credentials,updated_at FROM providers WHERE name=$1 FOR UPDATE",
        [PROVIDER_NAME],
      );
      const encryptedCredentials = input.clearAppKey
        ? null
        : input.appKey
          ? encryptSecret(
              JSON.stringify({ appKey: input.appKey }),
              config.PROVIDER_ENCRYPTION_KEY,
            )
          : (current.rows[0]?.encrypted_credentials ?? null);
            const provider = await client.query<{ id: string }>(
                `INSERT INTO providers(name,protocol,base_url,enabled,encrypted_credentials,created_by)
                 VALUES($1,'custom',$2,$3,$4,$5)
                 ON CONFLICT(name) DO UPDATE SET protocol='custom',base_url=EXCLUDED.base_url,enabled=EXCLUDED.enabled,encrypted_credentials=EXCLUDED.encrypted_credentials,updated_at=now()
                 RETURNING id`,
                [PROVIDER_NAME, endpoint.baseUrl, Boolean(encryptedCredentials), encryptedCredentials, actor.id],
            );
      const providerId = provider.rows[0]!.id;
      const workflow = await client.query<{ id: string }>(
        `INSERT INTO workflow_configs(provider_id,name,protocol,capability,submit_path,request_template,output_path,poll_interval_ms,timeout_seconds,enabled,created_by)
                 VALUES($1,$2,'custom','edit',$3,$4,$5,2000,180,true,$6)
                 ON CONFLICT(provider_id,name) DO UPDATE SET protocol='custom',capability='edit',submit_path=EXCLUDED.submit_path,request_template=EXCLUDED.request_template,output_path=EXCLUDED.output_path,enabled=true,updated_at=now()
                 RETURNING id`,
        [
          providerId,
          WORKFLOW_NAME,
          endpoint.submitPath,
          internalAiRequestTemplate(),
          WORKFLOW_OUTPUT_PATH,
          actor.id,
        ],
      );
      const model = await client.query<{ id: string }>(
        `INSERT INTO model_configs(provider_id,workflow_config_id,name,model_id,capabilities,credit_cost,rmb_cost,concurrency_limit,enabled,created_by)
                 VALUES($1,$2,$3,$4,ARRAY['edit'],0,0,5,true,$5)
                 ON CONFLICT(provider_id,model_id) DO UPDATE SET workflow_config_id=EXCLUDED.workflow_config_id,name=EXCLUDED.name,capabilities=EXCLUDED.capabilities,enabled=true,updated_at=now()
                 RETURNING id`,
        [providerId, workflow.rows[0]!.id, "四方连续进阶", MODEL_ID, actor.id],
      );
      await client.query(
        `INSERT INTO tool_api_configurations(tool_key,model_config_id,enabled,updated_by)
         VALUES('seamless-stitch',$1,true,$2)
         ON CONFLICT(tool_key) DO UPDATE SET model_config_id=EXCLUDED.model_config_id,enabled=true,updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [model.rows[0]!.id, actor.id],
      );
      await client.query("COMMIT");
      await writeAudit(db, {
        actor,
        action: "internal_ai.configured",
        targetType: "provider",
        targetId: providerId,
        result: "success",
        detail: {
          endpoint: input.seamlessUrl,
          credentialsChanged: Boolean(input.appKey || input.clearAppKey),
          credentialsCleared: Boolean(input.clearAppKey),
        },
        ip: request.ip,
      });
      response.json(await readPublicConfig(db, config));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      next(error);
    } finally {
      client.release();
    }
  });

  router.post("/test", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const resolved = await readResolvedConfig(db, config);
      const upstream = await callInternalAi(
        resolved.seamlessUrl,
        resolved.appKey,
        {
          image: TEST_IMAGE_BASE64,
          taskId: randomUUID(),
          ...internalAiSeamlessDefaults,
        },
      );
      await writeAudit(db, {
        actor,
        action: "internal_ai.connection_tested",
        targetType: "provider",
        targetId: resolved.providerId,
        result: "success",
        detail: { status: upstream.status, resultCount: upstream.resultCount },
        ip: request.ip,
      });
      response.json({ ok: true, message: `内部 AI 无缝拼接已完成真实测试出图（${upstream.resultCount} 张）` });
    } catch (error) {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      await writeAudit(db, {
        actor,
        action: "internal_ai.connection_tested",
        targetType: "provider",
        result: "failed",
        detail: { reason: error instanceof Error ? error.message : "连接失败" },
        ip: request.ip,
      }).catch(() => undefined);
      next(error);
    }
  });
  return router;
}

export function splitInternalAiUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("接口地址必须使用 HTTP 或 HTTPS");
  const submitPath = `${url.pathname || "/"}${url.search}`;
  return { baseUrl: url.origin, submitPath };
}

export function internalAiRequestTemplate() {
  return {
    model_code: MODEL_ID,
    task_id: "$taskId",
    app_key: "$appKey",
    input_image: "$sourceBase64",
    cut_width: "$cutWidth",
    redraw_width: "$redrawWidth",
    blur_amount: "$blurAmount",
    redraw_strength: "$redrawStrength",
    steps: "$steps",
  };
}

async function readPublicConfig(db: Database, config: AppConfig) {
  const result = await db.query<ProviderRow & { submit_path: string | null }>(
    `SELECT p.id,p.base_url,p.encrypted_credentials,p.updated_at,w.submit_path
         FROM providers p LEFT JOIN workflow_configs w ON w.provider_id=p.id AND w.name=$2 WHERE p.name=$1`,
    [PROVIDER_NAME, WORKFLOW_NAME],
  );
  const row = result.rows[0];
  const appKey =
    row?.encrypted_credentials && config.PROVIDER_ENCRYPTION_KEY
      ? readAppKey(row.encrypted_credentials, config.PROVIDER_ENCRYPTION_KEY)
      : "";
  return {
    seamlessUrl: row ? joinUrl(row.base_url, row.submit_path || "/") : "",
    hasAppKey: Boolean(appKey),
    appKeyPreview: previewSecret(appKey),
    updatedAt: row?.updated_at ?? null,
    protocol: "app-key-json" as const,
  };
}

async function readResolvedConfig(db: Database, config: AppConfig) {
  if (!config.PROVIDER_ENCRYPTION_KEY)
    throw new Error("服务端尚未配置 Provider 凭据加密密钥");
  const result = await db.query<ProviderRow & { submit_path: string | null }>(
    `SELECT p.id,p.base_url,p.encrypted_credentials,p.updated_at,w.submit_path
         FROM providers p LEFT JOIN workflow_configs w ON w.provider_id=p.id AND w.name=$2 WHERE p.name=$1 AND p.enabled=true`,
    [PROVIDER_NAME, WORKFLOW_NAME],
  );
  const row = result.rows[0];
  if (!row?.encrypted_credentials || !row.submit_path)
    throw new Error("管理员尚未在服务端配置内部 AI App Key");
  return {
    providerId: row.id,
    seamlessUrl: joinUrl(row.base_url, row.submit_path),
    appKey: readAppKey(
      row.encrypted_credentials,
      config.PROVIDER_ENCRYPTION_KEY,
    ),
  };
}

async function callInternalAi(
  url: string,
  appKey: string,
  input: {
    image: string;
    taskId: string;
    cutWidth: number;
    redrawWidth: number;
    blurAmount: number;
    redrawStrength: number;
    steps: number;
  },
) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model_code: MODEL_ID,
      task_id: input.taskId,
      app_key: appKey,
      input_image: input.image,
      cut_width: input.cutWidth,
      redraw_width: input.redrawWidth,
      blur_amount: input.blurAmount,
      redraw_strength: input.redrawStrength,
      steps: input.steps,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  const payload = text
    ? (JSON.parse(text) as {
        success?: string;
        err_msg?: string;
        error_msg?: string;
      })
    : {};
  if (!response.ok || (payload.success && payload.success !== "OK"))
    throw new Error(
      payload.err_msg ||
        payload.error_msg ||
        `内部 AI 接口返回 HTTP ${response.status}`,
    );
  const outputs = normalizeWorkflowOutputs(readPath(payload, WORKFLOW_OUTPUT_PATH));
  if (!outputs.length) throw new Error("内部 AI 接口未返回图片结果");
  return { status: response.status, resultCount: outputs.length };
}

function readAppKey(encrypted: string, key: string) {
  const value = JSON.parse(decryptSecret(encrypted, key)) as {
    appKey?: string;
  };
  return value.appKey?.trim() || "";
}

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function previewSecret(value: string) {
  if (!value) return "";
  return value.length <= 8
    ? `${value.slice(0, 2)}****`
    : `${value.slice(0, 4)}****${value.slice(-4)}`;
}
