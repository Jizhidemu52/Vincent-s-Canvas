import { Router } from "express";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { AppConfig } from "../config";
import type { Database } from "../db";
import { requireRole } from "../rbac";
import { encryptSecret } from "../security";
import type { AuthenticatedRequest } from "../types";

const protocol = z.enum(["openai", "gemini", "volcengine", "runninghub", "comfyui", "custom"]);
const capabilities = z.array(z.enum(["generate", "edit", "upscale", "remove_background", "batch"])).min(1);
const providerInput = z.object({ name: z.string().trim().min(1).max(100), protocol, baseUrl: z.string().url(), enabled: z.boolean().default(true), credentials: z.record(z.string(), z.string().max(10_000)).optional() });
const providerUpdate = providerInput.partial();
const modelInput = z.object({ providerId: z.string().uuid(), name: z.string().trim().min(1).max(120), modelId: z.string().trim().min(1).max(200), capabilities, creditCost: z.number().int().nonnegative(), rmbCost: z.number().nonnegative(), concurrencyLimit: z.number().int().min(1).max(100).default(5), enabled: z.boolean().default(true) });
const modelUpdate = modelInput.partial();
const priceInput = z.object({ operationType: z.enum(["image_generation", "upscale", "remove_background", "inpaint", "batch_image", "seamless_stitch"]), label: z.string().trim().min(1).max(100), credits: z.number().int().nonnegative(), rmbCost: z.number().nonnegative() });

const providerSelect = `id,name,protocol,base_url AS "baseUrl",enabled,(encrypted_credentials IS NOT NULL) AS "hasCredentials",created_at AS "createdAt",updated_at AS "updatedAt"`;
const modelSelect = `m.id,m.provider_id AS "providerId",p.name AS "providerName",m.name,m.model_id AS "modelId",m.capabilities,m.credit_cost AS "creditCost",m.rmb_cost::float8 AS "rmbCost",m.concurrency_limit AS "concurrencyLimit",m.enabled,m.created_at AS "createdAt",m.updated_at AS "updatedAt"`;

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
        try { response.json({ models: (await db.query(`SELECT ${modelSelect} FROM model_configs m JOIN providers p ON p.id=m.provider_id ORDER BY m.name`)).rows }); }
        catch (error) { next(error); }
    });
    router.post("/models", async (request, response, next) => {
        try {
            const input = modelInput.parse(request.body); const actor = (request as unknown as AuthenticatedRequest).auth;
            const result = await db.query(`INSERT INTO model_configs(provider_id,name,model_id,capabilities,credit_cost,rmb_cost,concurrency_limit,enabled,created_by)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [input.providerId, input.name, input.modelId, input.capabilities, input.creditCost, input.rmbCost, input.concurrencyLimit, input.enabled, actor.id]);
            const model = (await db.query(`SELECT ${modelSelect} FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.id=$1`, [result.rows[0].id])).rows[0];
            await writeAudit(db, { actor, action: "model.created", targetType: "model", targetId: model.id, result: "success", detail: { modelId: input.modelId }, ip: request.ip });
            response.status(201).json({ model });
        } catch (error) { next(error); }
    });
    router.patch("/models/:id", async (request, response, next) => {
        try {
            const input = modelUpdate.parse(request.body); const actor = (request as unknown as AuthenticatedRequest).auth;
            const current = await db.query(`SELECT ${modelSelect} FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.id=$1`, [request.params.id]);
            if (!current.rows[0]) { response.status(404).json({ error: "NOT_FOUND", message: "模型不存在" }); return; }
            const value = { ...current.rows[0], ...input };
            await db.query(`UPDATE model_configs SET provider_id=$1,name=$2,model_id=$3,capabilities=$4,credit_cost=$5,rmb_cost=$6,concurrency_limit=$7,enabled=$8,updated_at=now() WHERE id=$9`,
                [value.providerId, value.name, value.modelId, value.capabilities, value.creditCost, value.rmbCost, value.concurrencyLimit, value.enabled, request.params.id]);
            const model = (await db.query(`SELECT ${modelSelect} FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.id=$1`, [request.params.id])).rows[0];
            await writeAudit(db, { actor, action: "model.updated", targetType: "model", targetId: model.id, result: "success", detail: { fields: Object.keys(input) }, ip: request.ip });
            response.json({ model });
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
            const [models, prices] = await Promise.all([
                db.query(`SELECT m.id,m.name,m.model_id AS "modelId",m.capabilities,m.credit_cost AS "creditCost",m.rmb_cost::float8 AS "rmbCost" FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.enabled=true AND p.enabled=true ORDER BY m.name`),
                db.query(`SELECT operation_type AS "operationType",label,credits,rmb_cost::float8 AS "rmbCost",version FROM pricing_rule_versions WHERE status='published' ORDER BY operation_type`),
            ]);
            response.json({ models: models.rows, prices: prices.rows });
        } catch (error) { next(error); }
    });
    return router;
}
