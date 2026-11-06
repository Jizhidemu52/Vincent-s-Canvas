import { Router } from "express";
import { PRODUCT_CANDIDATES_PROFILE, productCandidatesResultSchema, type ProductCandidate, type ProductCandidatesReceipt } from "../../../shared/product-candidates";
import type { AppConfig } from "../config";
import type { Cache, Database } from "../db";
import type { AuthenticatedRequest } from "../types";
import { writeAudit } from "../audit";
import { beginChatBilling, finishChatBilling } from "../chat-billing";
import { getCreditsEnabled } from "../credit-policy";
import { deploymentFeatures } from "../deployment-features";
import { resolveToolExecution } from "../tool-configuration";
import { decryptSecret } from "../security";
import { beginUsageChat, finishUsageChat } from "../usage-analytics";
import { PromptOptimizationError } from "../prompt-safety";
import { readProviderSubmissionDiagnostics } from "../provider-submission-transport";
import { isDefinitiveSubmissionRejection } from "../provider-submission-policy";
import {
    claimProductCandidatesReceipt, finishProductCandidatesReceipt, productCandidatesProfileInput,
    productCandidatesRequestIdSchema, productCandidatesRequestSchema, publicProductCandidatesReceipt,
    readProductCandidateSource, readProductCandidatesReceipt, validateProductCandidatesOutput,
    type ProductCandidateSourceRuntime, type StoredProductCandidatesReceipt,
} from "../product-candidates";
import type { requestChatCompletion } from "./chat";
import type { ProductCandidatesReceiptConnection } from "../product-candidates-redis";

export type ProductCandidatesRouterOptions = {
    cache?: Pick<Cache, "get" | "eval">;
    sourceRuntime?: ProductCandidateSourceRuntime;
    openReceiptConnection?: () => Promise<ProductCandidatesReceiptConnection>;
};

/** Narrow observation profile: it cannot invoke image tasks or client tools. */
export function createProductCandidatesRouter(db: Database, config: AppConfig, complete: typeof requestChatCompletion, options: ProductCandidatesRouterOptions) {
    const router = Router();
    const features = deploymentFeatures(config);
    const openReceiptConnection = async () => {
        if (!options.openReceiptConnection) throw new PromptOptimizationError("PRODUCT_CANDIDATES_RECEIPT_UNAVAILABLE", "识别回执持久化暂不可用，请保留原请求编号，不要重复提交。", 503);
        return options.openReceiptConnection();
    };
    const persist = async (stored: StoredProductCandidatesReceipt, update: Pick<ProductCandidatesReceipt, "status" | "candidates" | "errorCode" | "message">) => {
        const connection = await openReceiptConnection();
        try {
            const result = await finishProductCandidatesReceipt(connection.cache, stored, update);
            if (!await connection.confirmPersistence()) throw new Error("Receipt persistence unconfirmed");
            return result;
        } finally { connection.close(); }
    };
    const failure = (error: unknown) => error instanceof PromptOptimizationError
        ? { status: error.status, error: error.code, message: error.message }
        : { status: 503, error: "PRODUCT_CANDIDATES_UNAVAILABLE", message: "产品识别暂不可用，未发送新的识别请求。" };

    router.get("/responses/:requestId", async (request, response) => {
        response.setHeader("cache-control", "no-store");
        if (request.query.profile !== PRODUCT_CANDIDATES_PROFILE) {
            response.status(400).json({ error: "PRODUCT_CANDIDATES_PROFILE_INVALID", message: "请指定产品识别回执类型。" }); return;
        }
        const id = productCandidatesRequestIdSchema.safeParse(request.params.requestId);
        if (!id.success) { response.status(400).json({ error: "PRODUCT_CANDIDATES_REQUEST_INVALID", message: "请求编号无效。" }); return; }
        try {
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const stored = await readProductCandidatesReceipt(options.cache, actor.id, id.data);
            if (!stored) { response.status(404).json({ error: "PRODUCT_CANDIDATES_RECEIPT_NOT_FOUND", message: "未找到当前账号的原请求回执，请保留原请求编号核查，不要重新提交。" }); return; }
            response.json(publicProductCandidatesReceipt(stored));
        } catch (error) { const result = failure(error); response.status(result.status).json({ error: result.error, message: result.message }); }
    });

    router.post("/responses", async (request, response, next) => {
        if (request.body?.profile !== PRODUCT_CANDIDATES_PROFILE) { next(); return; }
        response.setHeader("cache-control", "no-store");
        const parsed = productCandidatesRequestSchema.safeParse(request.body);
        if (!parsed.success) { response.status(400).json({ error: "PRODUCT_CANDIDATES_REQUEST_INVALID", message: "识别仅接受一张自有图片和原请求编号，不允许附加提示词、模型参数或执行工具。" }); return; }
        let claimed: StoredProductCandidatesReceipt | undefined;
        let billingReservationId: string | null = null;
        let usageRequestId: string | undefined;
        let providerStarted = false;
        let providerReturned = false;
        let settlementAttempted = false;
        let durabilityUncertain = false;
        let candidates: ProductCandidate[] | undefined;
        const actor = (request as unknown as AuthenticatedRequest).auth;
        const recordUsage = async () => {
            if (usageRequestId) await finishUsageChat(db, usageRequestId, candidates ? "success" : "failed").catch(() => undefined);
        };
        try {
            if (!actor?.id || (request as AuthenticatedRequest).allowsAnonymousCreation) throw new PromptOptimizationError("PRODUCT_CANDIDATES_AUTH_REQUIRED", "请登录后识别自己的图片。", 403);
            const existing = await readProductCandidatesReceipt(options.cache, actor.id, parsed.data.requestId);
            if (existing) {
                if (existing.receipt.sourceAssetId !== parsed.data.profileContext.sourceAssetId) throw new PromptOptimizationError("PRODUCT_CANDIDATES_REQUEST_CHANGED", "原请求编号对应其他图片，未发送新的识别请求。", 409);
                response.json(publicProductCandidatesReceipt(existing)); return;
            }
            const source = await readProductCandidateSource(db, config, actor.id, parsed.data.profileContext.sourceAssetId, options.sourceRuntime);
            const execution = await resolveToolExecution(db, { toolKey: "gpt-chat", operationType: "chat" });
            const result = await db.query<{ model_id: string; base_url: string; protocol: string; encrypted_credentials: string | null }>(
                `SELECT m.model_id,p.base_url,p.protocol,p.encrypted_credentials FROM model_configs m JOIN providers p ON p.id=m.provider_id
                 WHERE m.id=$1 AND m.enabled=true AND p.enabled=true AND 'chat'=ANY(m.capabilities) LIMIT 1`, [execution.modelConfigId]);
            const model = result.rows[0];
            if (!model) throw new PromptOptimizationError("MODEL_DISABLED", "管理员尚未启用识别使用的对话模型。", 400);
            if (!model.encrypted_credentials || !config.PROVIDER_ENCRYPTION_KEY) throw new PromptOptimizationError("PROVIDER_NOT_CONFIGURED", "对话模型服务端凭据未配置。", 503);
            if (!["openai", "custom", "apimart", "gemini", "anthropic", "openai-chat"].includes(model.protocol)) throw new PromptOptimizationError("PROTOCOL_NOT_SUPPORTED", "当前对话模型协议不支持产品识别。", 400);
            const credentials = JSON.parse(decryptSecret(model.encrypted_credentials, config.PROVIDER_ENCRYPTION_KEY)) as Record<string, string>;
            const connection = await openReceiptConnection();
            try {
                const claim = await claimProductCandidatesReceipt(connection.cache, actor.id, parsed.data, source.sourceHash, execution.modelConfigId);
                if (!claim.execute) { response.json(publicProductCandidatesReceipt(claim.stored)); return; }
                claimed = claim.stored;
                durabilityUncertain = true;
                if (!await connection.confirmPersistence()) throw new Error("Claim persistence unconfirmed");
                durabilityUncertain = false;
            } finally { connection.close(); }
            billingReservationId = await beginChatBilling(db, { requestId: parsed.data.requestId, userId: actor.id, anonymous: false,
                enabled: features.authenticationEnabled && await getCreditsEnabled(db, features.creditsEnabled), execution });
            if (response.destroyed || request.aborted) throw new PromptOptimizationError("PRODUCT_CANDIDATES_CANCELLED", "识别请求已中断，尚未发送模型请求。", 409);
            if (features.authenticationEnabled) usageRequestId = await beginUsageChat(db, { userId: actor.id, modelConfigId: execution.modelConfigId, boardKey: execution.toolKey, input: [] });
            providerStarted = true;
            const resultPayload = await complete(model, credentials, productCandidatesProfileInput(source).input);
            providerReturned = true;
            const validated = validateProductCandidatesOutput(resultPayload);
            candidates = productCandidatesResultSchema.parse(JSON.parse(validated.toolCalls[0]!.function.arguments)).candidates;
            // Once output is valid, bookkeeping cannot turn it into a retryable
            // failure. A settlement exception is unknown, never a second refund.
            settlementAttempted = true;
            await finishChatBilling(db, billingReservationId, true);
            billingReservationId = null;
            const completed = await persist(claimed, { status: "success", candidates });
            await recordUsage();
            await writeAudit(db, { actor, action: "chat.completed", targetType: "model", targetId: execution.modelConfigId, result: "success",
                detail: { protocol: model.protocol, profile: PRODUCT_CANDIDATES_PROFILE, candidateCount: candidates.length, toolKey: execution.toolKey, configurationVersion: execution.configurationVersion }, ip: request.ip }).catch(() => undefined);
            response.json(publicProductCandidatesReceipt(completed));
        } catch (error) {
            let settlementUncertain = settlementAttempted && billingReservationId !== null;
            if (billingReservationId && !settlementAttempted) {
                settlementAttempted = true;
                try { await finishChatBilling(db, billingReservationId, false); billingReservationId = null; }
                catch { settlementUncertain = true; }
            }
            await recordUsage();
            if (!claimed) { const result = failure(error); response.status(result.status).json({ error: result.error, message: result.message }); return; }
            const diagnostics = readProviderSubmissionDiagnostics(error);
            const status = error && typeof error === "object" && "upstreamStatus" in error ? Number(error.upstreamStatus) : undefined;
            const known = !candidates && !settlementUncertain && !durabilityUncertain && (!providerStarted || providerReturned || diagnostics?.phase === "initial_tls" || diagnostics?.phase === "preflight"
                || (status !== undefined && isDefinitiveSubmissionRejection(status)));
            const update = known
                ? { status: "failed" as const, errorCode: "PRODUCT_CANDIDATES_FAILED", message: "本次识别未完成，未执行图片处理；不会自动重试。你可以明确重新发起一次识别。" }
                : { status: "uncertain" as const, ...(candidates ? { candidates } : {}), errorCode: "PRODUCT_CANDIDATES_UNCERTAIN", message: "原识别请求结果或结算待核查，请只查询原请求或联系管理员，不要重新提交。" };
            try {
                // A write may have committed before its reply was lost. Read
                // once, and never downgrade an already completed receipt.
                const existing = await readProductCandidatesReceipt(options.cache, claimed.ownerId, claimed.receipt.requestId);
                if (existing && existing.receipt.status !== "processing") { response.json(publicProductCandidatesReceipt(existing)); return; }
                response.json(publicProductCandidatesReceipt(await persist(claimed, update)));
            }
            catch {
                // The claim remains durable. A cache write outage must never be
                // presented as permission to submit another charged request.
                response.json({ ...claimed.receipt, status: "uncertain", ...(candidates ? { candidates } : {}), errorCode: "PRODUCT_CANDIDATES_RECEIPT_UNAVAILABLE", message: "原请求回执暂不可用，请保留原编号并只查询原请求，不要重新提交。" });
            }
        }
    });
    return router;
}
