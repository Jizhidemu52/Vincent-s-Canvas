import { Router } from "express";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { AppConfig } from "../config";
import type { Database } from "../db";
import { requireRole } from "../rbac";
import { encryptSecret } from "../security";
import { assertValidModelReplacement } from "../prompt-templates";
import type { AuthenticatedRequest } from "../types";

const protocol = z.enum(["openai", "gemini", "volcengine", "runninghub", "comfyui", "custom"]);
const capabilities = z.array(z.enum(["generate", "edit", "upscale", "remove_background", "batch", "chat", "video", "audio"])).min(1);
const providerInput = z.object({ name: z.string().trim().min(1).max(100), protocol, baseUrl: z.string().url(), enabled: z.boolean().default(true), credentials: z.record(z.string(), z.string().max(10_000)).optional() });
const providerUpdate = providerInput.partial();
const modelInput = z.object({ providerId: z.string().uuid(), workflowConfigId: z.string().uuid().nullish(), replacementModelConfigId: z.string().uuid().nullish(), name: z.string().trim().min(1).max(120), modelId: z.string().trim().min(1).max(200), capabilities, creditCost: z.number().int().nonnegative(), rmbCost: z.number().nonnegative(), concurrencyLimit: z.number().int().min(1).max(100).default(5), enabled: z.boolean().default(true) });
const modelUpdate = modelInput.partial();
const priceInput = z.object({ operationType: z.enum(["image_generation", "video_generation", "audio_generation", "upscale", "remove_background", "inpaint", "batch_image", "seamless_stitch"]), label: z.string().trim().min(1).max(100), credits: z.number().int().nonnegative(), rmbCost: z.number().nonnegative() });
const toolDefinitions = [
    { toolKey: "detail-enhance", label: "细节增强", operationType: "upscale", capabilities: ["upscale", "edit"] },
    { toolKey: "image-edit", label: "图片编辑", operationType: "inpaint", capabilities: ["edit"] },
    { toolKey: "angle-control", label: "角度控制", operationType: "inpaint", capabilities: ["edit"] },
    { toolKey: "seamless-stitch", label: "无缝拼接", operationType: "seamless_stitch", capabilities: ["edit"] },
    { toolKey: "image", label: "文生图", operationType: "image_generation", capabilities: ["generate"] },
    { toolKey: "video", label: "视频创作", operationType: "video_generation", capabilities: ["video"] },
] as const;
const toolKey = z.enum(toolDefinitions.map((item) => item.toolKey) as [typeof toolDefinitions[number]["toolKey"], ...Array<typeof toolDefinitions[number]["toolKey"]>]);
const toolConfigurationInput = z.object({ modelConfigId: z.string().uuid(), enabled: z.boolean().default(true) });

const providerSelect = `id,name,protocol,base_url AS "baseUrl",enabled,(encrypted_credentials IS NOT NULL) AS "hasCredentials",created_at AS "createdAt",updated_at AS "updatedAt"`;
const modelSelect = `m.id,m.provider_id AS "providerId",p.name AS "providerName",m.workflow_config_id AS "workflowConfigId",w.name AS "workflowName",m.replacement_model_config_id AS "replacementModelConfigId",m.name,m.model_id AS "modelId",m.capabilities,m.credit_cost AS "creditCost",m.rmb_cost::float8 AS "rmbCost",m.concurrency_limit AS "concurrencyLimit",m.enabled,m.created_at AS "createdAt",m.updated_at AS "updatedAt"`;

export function createModelConfigurationRouter(db: Database, config: AppConfig) {
    const router = Router();
    router.use(requireRole("super_admin"));

    router.get("/providers", async (_request, response, next) => {
        try { response.json({ providers: (await db.query(`SELECT ${providerSelect} FROM providers ORDER BY name`)).rows }); }
        catch (error) { next(error); }
    });
    router.post("/providers", async (request, response, next) => {
        try {
            const input = providerInput.parse(request.body);
            if (input.credentials && !config.PROVIDER_ENCRYPTION_KEY) { response.status(503).json({ error: "SECRET_KEY_NOT_CONFIGURED", message: "服务器尚未配置 Provider 凭据加密密钥" }); return; }
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const encrypted = input.credentials ? encryptSecret(JSON.stringify(input.credentials), config.PROVIDER_ENCRYPTION_KEY!) : null;
            const result = await db.query(`INSERT INTO providers(name,protocol,base_url,enabled,encrypted_credentials,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${providerSelect}`,
                [input.name, input.protocol, input.baseUrl, input.enabled, encrypted, actor.id]);
            await writeAudit(db, { actor, action: "provider.created", targetType: "provider", targetId: result.rows[0].id, result: "success", detail: { name: input.name, protocol: input.protocol, credentialsConfigured: Boolean(input.credentials) }, ip: request.ip });
            response.status(201).json({ provider: result.rows[0] });
        } catch (error) { next(error); }
    });
    router.patch("/providers/:id", async (request, response, next) => {
        try {
            const input = providerUpdate.parse(request.body);
            if (input.credentials && !config.PROVIDER_ENCRYPTION_KEY) { response.status(503).json({ error: "SECRET_KEY_NOT_CONFIGURED", message: "服务器尚未配置 Provider 凭据加密密钥" }); return; }
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const current = await db.query(`SELECT ${providerSelect} FROM providers WHERE id=$1`, [request.params.id]);
            if (!current.rows[0]) { response.status(404).json({ error: "NOT_FOUND", message: "Provider 不存在" }); return; }
            const encrypted = input.credentials ? encryptSecret(JSON.stringify(input.credentials), config.PROVIDER_ENCRYPTION_KEY!) : undefined;
            const result = await db.query(`UPDATE providers SET name=$1,protocol=$2,base_url=$3,enabled=$4,encrypted_credentials=COALESCE($5,encrypted_credentials),updated_at=now() WHERE id=$6 RETURNING ${providerSelect}`,
                [input.name ?? current.rows[0].name, input.protocol ?? current.rows[0].protocol, input.baseUrl ?? current.rows[0].baseUrl, input.enabled ?? current.rows[0].enabled, encrypted ?? null, request.params.id]);
            await writeAudit(db, { actor, action: "provider.updated", targetType: "provider", targetId: request.params.id, result: "success", detail: { fields: Object.keys(input), credentialsChanged: Boolean(input.credentials) }, ip: request.ip });
            response.json({ provider: result.rows[0] });
        } catch (error) { next(error); }
    });

    router.get("/models", async (_request, response, next) => {
        try { response.json({ models: (await db.query(`SELECT ${modelSelect} FROM model_configs m JOIN providers p ON p.id=m.provider_id LEFT JOIN workflow_configs w ON w.id=m.workflow_config_id ORDER BY m.name`)).rows }); }
        catch (error) { next(error); }
    });
    router.post("/models", async (request, response, next) => {
        try {
            const input = modelInput.parse(request.body); const actor = (request as unknown as AuthenticatedRequest).auth;
            if (input.replacementModelConfigId && !(await db.query("SELECT 1 FROM model_configs WHERE id=$1", [input.replacementModelConfigId])).rows[0]) { response.status(400).json({ error: "INVALID_MODEL_REPLACEMENT", message: "替代模型不存在" }); return; }
            const result = await db.query(`INSERT INTO model_configs(provider_id,workflow_config_id,replacement_model_config_id,name,model_id,capabilities,credit_cost,rmb_cost,concurrency_limit,enabled,created_by)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [input.providerId, input.workflowConfigId ?? null, input.replacementModelConfigId ?? null, input.name, input.modelId, input.capabilities, input.creditCost, input.rmbCost, input.concurrencyLimit, input.enabled, actor.id]);
            const model = (await db.query(`SELECT ${modelSelect} FROM model_configs m JOIN providers p ON p.id=m.provider_id LEFT JOIN workflow_configs w ON w.id=m.workflow_config_id WHERE m.id=$1`, [result.rows[0].id])).rows[0];
            await writeAudit(db, { actor, action: "model.created", targetType: "model", targetId: model.id, result: "success", detail: { modelId: input.modelId }, ip: request.ip });
            response.status(201).json({ model });
        } catch (error) { next(error); }
    });
    router.patch("/models/:id", async (request, response, next) => {
        try {
            const input = modelUpdate.parse(request.body); const actor = (request as unknown as AuthenticatedRequest).auth;
            const current = await db.query(`SELECT ${modelSelect} FROM model_configs m JOIN providers p ON p.id=m.provider_id LEFT JOIN workflow_configs w ON w.id=m.workflow_config_id WHERE m.id=$1`, [request.params.id]);
            if (!current.rows[0]) { response.status(404).json({ error: "NOT_FOUND", message: "模型不存在" }); return; }
            const value = { ...current.rows[0], ...input };
            await assertValidModelReplacement(db, request.params.id, value.replacementModelConfigId ?? null);
            await db.query(`UPDATE model_configs SET provider_id=$1,workflow_config_id=$2,replacement_model_config_id=$3,name=$4,model_id=$5,capabilities=$6,credit_cost=$7,rmb_cost=$8,concurrency_limit=$9,enabled=$10,updated_at=now() WHERE id=$11`,
                [value.providerId, value.workflowConfigId ?? null, value.replacementModelConfigId ?? null, value.name, value.modelId, value.capabilities, value.creditCost, value.rmbCost, value.concurrencyLimit, value.enabled, request.params.id]);
            const model = (await db.query(`SELECT ${modelSelect} FROM model_configs m JOIN providers p ON p.id=m.provider_id LEFT JOIN workflow_configs w ON w.id=m.workflow_config_id WHERE m.id=$1`, [request.params.id])).rows[0];
            await writeAudit(db, { actor, action: "model.updated", targetType: "model", targetId: model.id, result: "success", detail: { fields: Object.keys(input) }, ip: request.ip });
            response.json({ model });
        } catch (error) { next(error); }
    });

    router.get("/tool-configurations", async (_request, response, next) => {
        try {
            const rows = (await db.query(`SELECT t.tool_key AS "toolKey",t.model_config_id AS "modelConfigId",t.enabled,
                m.name AS "modelName",m.model_id AS "modelId",m.capabilities,m.credit_cost AS "modelCreditCost",
                m.rmb_cost::float8 AS "modelRmbCost",m.enabled AS "modelEnabled",p.id AS "providerId",p.name AS "providerName",
                p.protocol,p.base_url AS "baseUrl",p.enabled AS "providerEnabled",(p.encrypted_credentials IS NOT NULL) AS "hasCredentials",
                m.workflow_config_id AS "workflowConfigId",w.name AS "workflowName",w.enabled AS "workflowEnabled"
                FROM tool_api_configurations t JOIN model_configs m ON m.id=t.model_config_id
                JOIN providers p ON p.id=m.provider_id LEFT JOIN workflow_configs w ON w.id=m.workflow_config_id`)).rows as Array<Record<string, unknown>>;
            const prices = (await db.query(`SELECT operation_type AS "operationType",credits,rmb_cost::float8 AS "rmbCost",version
                FROM pricing_rule_versions WHERE status='published'`)).rows as Array<Record<string, unknown>>;
            response.json({ tools: toolDefinitions.map((definition) => ({
                ...definition,
                ...(rows.find((row) => row.toolKey === definition.toolKey) || { modelConfigId: null, enabled: false }),
                price: prices.find((price) => price.operationType === definition.operationType) || null,
            })) });
        } catch (error) { next(error); }
    });
    router.put("/tool-configurations/:toolKey", async (request, response, next) => {
        try {
            const selectedTool = toolKey.parse(request.params.toolKey);
            const input = toolConfigurationInput.parse(request.body);
            const definition = toolDefinitions.find((item) => item.toolKey === selectedTool)!;
            const model = await db.query<{ capabilities: string[] }>(`SELECT m.capabilities FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.id=$1`, [input.modelConfigId]);
            if (!model.rows[0]) { response.status(400).json({ error: "MODEL_NOT_FOUND", message: "所选模型不存在" }); return; }
            if (!definition.capabilities.some((capability) => model.rows[0]!.capabilities.includes(capability))) {
                response.status(400).json({ error: "MODEL_CAPABILITY_MISMATCH", message: `所选模型不支持${definition.label}` }); return;
            }
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const result = await db.query(`INSERT INTO tool_api_configurations(tool_key,model_config_id,enabled,updated_by)
                VALUES($1,$2,$3,$4) ON CONFLICT(tool_key) DO UPDATE SET model_config_id=EXCLUDED.model_config_id,
                enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=now()
                RETURNING tool_key AS "toolKey",model_config_id AS "modelConfigId",enabled,updated_at AS "updatedAt"`,
                [selectedTool, input.modelConfigId, input.enabled, actor.id]);
            await writeAudit(db, { actor, action: "tool_api_configuration.updated", targetType: "tool", targetId: selectedTool, result: "success", detail: { modelConfigId: input.modelConfigId, enabled: input.enabled }, ip: request.ip });
            response.json({ tool: result.rows[0] });
        } catch (error) { next(error); }
    });

    router.get("/prices", async (_request, response, next) => {
        try { response.json({ prices: (await db.query(`SELECT id,operation_type AS "operationType",label,credits,rmb_cost::float8 AS "rmbCost",version,status,created_at AS "createdAt",published_at AS "publishedAt" FROM pricing_rule_versions ORDER BY operation_type,version DESC`)).rows }); }
        catch (error) { next(error); }
    });
    router.post("/prices", async (request, response, next) => {
        try {
            const input = priceInput.parse(request.body); const actor = (request as unknown as AuthenticatedRequest).auth;
            const result = await db.query(`INSERT INTO pricing_rule_versions(operation_type,label,credits,rmb_cost,version,status,created_by)
                SELECT $1,$2,$3,$4,COALESCE(MAX(version),0)+1,'draft',$5 FROM pricing_rule_versions WHERE operation_type=$1 RETURNING id,operation_type AS "operationType",label,credits,rmb_cost::float8 AS "rmbCost",version,status`,
                [input.operationType, input.label, input.credits, input.rmbCost, actor.id]);
            await writeAudit(db, { actor, action: "price.draft_created", targetType: "price", targetId: result.rows[0].id, result: "success", detail: input, ip: request.ip });
            response.status(201).json({ price: result.rows[0] });
        } catch (error) { next(error); }
    });
    router.post("/prices/:id/test", async (request, response, next) => {
        try {
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const result = await db.query("UPDATE pricing_rule_versions SET status='testing' WHERE id=$1 AND status='draft' RETURNING id", [request.params.id]);
            if (!result.rows[0]) { response.status(409).json({ error: "INVALID_STATE", message: "只有草稿价格可以进入测试" }); return; }
            await writeAudit(db, { actor, action: "price.testing", targetType: "price", targetId: request.params.id, result: "success", ip: request.ip });
            response.status(204).end();
        } catch (error) { next(error); }
    });
    router.post("/prices/:id/publish", async (request, response, next) => {
        const client = await db.connect();
        try {
            const actor = (request as unknown as AuthenticatedRequest).auth;
            await client.query("BEGIN");
            const target = await client.query<{ operation_type: string }>("SELECT operation_type FROM pricing_rule_versions WHERE id=$1 AND status IN ('draft','testing') FOR UPDATE", [request.params.id]);
            if (!target.rows[0]) { await client.query("ROLLBACK"); response.status(409).json({ error: "INVALID_STATE", message: "该价格版本不能发布" }); return; }
            await client.query("UPDATE pricing_rule_versions SET status='retired' WHERE operation_type=$1 AND status='published'", [target.rows[0].operation_type]);
            await client.query("UPDATE pricing_rule_versions SET status='published',published_at=now() WHERE id=$1", [request.params.id]);
            await client.query("COMMIT");
            await writeAudit(db, { actor, action: "price.published", targetType: "price", targetId: request.params.id, result: "success", detail: { operationType: target.rows[0].operation_type }, ip: request.ip });
            response.status(204).end();
        } catch (error) { await client.query("ROLLBACK").catch(() => undefined); next(error); }
        finally { client.release(); }
    });
    return router;
}

export function createPublicModelRouter(db: Database) {
    const router = Router();
    router.get("/", async (_request, response, next) => {
        try {
            const [models, prices, tools] = await Promise.all([
                db.query(`SELECT m.id,m.name,m.model_id AS "modelId",m.capabilities,m.credit_cost AS "creditCost",m.rmb_cost::float8 AS "rmbCost" FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.enabled=true AND p.enabled=true ORDER BY m.name`),
                db.query(`SELECT operation_type AS "operationType",label,credits,rmb_cost::float8 AS "rmbCost",version FROM pricing_rule_versions WHERE status='published' ORDER BY operation_type`),
                db.query(`SELECT t.tool_key AS "toolKey",t.model_config_id AS "modelConfigId"
                    FROM tool_api_configurations t JOIN model_configs m ON m.id=t.model_config_id
                    JOIN providers p ON p.id=m.provider_id LEFT JOIN workflow_configs w ON w.id=m.workflow_config_id
                    WHERE t.enabled=true AND m.enabled=true AND p.enabled=true
                    AND (m.workflow_config_id IS NULL OR w.enabled=true)`),
            ]);
            response.json({ models: models.rows, prices: prices.rows, tools: tools.rows });
        } catch (error) { next(error); }
    });
    return router;
}
