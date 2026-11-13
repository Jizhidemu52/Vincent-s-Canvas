import { Router } from "express";
import type { Database, Cache } from "../db";
import type { AppConfig } from "../config";
import type { AuthenticatedRequest } from "../types";
import type { ProductCandidatesReceiptConnection } from "../product-candidates-redis";
import { resolveToolExecution } from "../tool-configuration";
import { decryptSecret } from "../security";
import { beginChatBilling, finishChatBilling } from "../chat-billing";
import { deploymentFeatures } from "../deployment-features";
import { getCreditsEnabled } from "../credit-policy";
import { writeAudit } from "../audit";
import { CHAT_COMPLETION_PROTOCOLS, requestChatCompletion } from "./chat";
import { claimDisplayTranslation, displayTranslationInput, displayTranslationRequestSchema, finishDisplayTranslation, readDisplayTranslation, reserveDisplayTranslationBudget, type DisplayTranslationReceipt } from "../display-translations";

export function createDisplayTranslationsRouter(db: Database, config: AppConfig, options: {
    cache: Pick<Cache, "get" | "eval">;
    openReceiptConnection: () => Promise<ProductCandidatesReceiptConnection>;
    complete?: typeof requestChatCompletion;
}) {
    const router = Router();
    router.post("/", async (request, response) => {
        response.setHeader("cache-control", "no-store");
        const actor = (request as unknown as AuthenticatedRequest).auth;
        if (!actor?.id || (request as AuthenticatedRequest).allowsAnonymousCreation || request.get("X-Canvas-Owner-Id") !== actor.id) {
            response.status(403).json({ error: "DISPLAY_TRANSLATION_AUTH_REQUIRED", message: "Sign in to translate your display text." }); return;
        }
        const parsed = displayTranslationRequestSchema.safeParse(request.body);
        if (!parsed.success) { response.status(400).json({ error: "DISPLAY_TRANSLATION_INPUT_INVALID", message: "Display translation accepts bounded English-only text batches." }); return; }
        let receipt: DisplayTranslationReceipt | undefined;
        let reservation: string | null = null;
        let settlementStarted = false;
        const send = (value: DisplayTranslationReceipt) => value.status === "ready"
            ? response.json({ translations: value.translations })
            : response.status(value.status === "pending" ? 202 : 503).json({ status: value.status, error: "DISPLAY_TRANSLATION_UNAVAILABLE", message: "The original text is preserved. This request will not be resubmitted automatically." });
        const persist = async (value: DisplayTranslationReceipt, translations?: string[]) => {
            const connection = await options.openReceiptConnection();
            try {
                const stored = await finishDisplayTranslation(connection.cache, value, translations);
                if (!await connection.confirmPersistence()) throw new Error("DISPLAY_TRANSLATION_PERSISTENCE_UNCERTAIN");
                return stored;
            } finally { connection.close(); }
        };
        try {
            const existing = await readDisplayTranslation(options.cache, actor.id, parsed.data);
            if (existing) { send(existing); return; }
            const execution = await resolveToolExecution(db, { toolKey: "gpt-chat", operationType: "chat" });
            const models = await db.query<{ model_id: string; base_url: string; protocol: string; encrypted_credentials: string | null }>(
                `SELECT m.model_id,p.base_url,p.protocol,p.encrypted_credentials FROM model_configs m JOIN providers p ON p.id=m.provider_id
                 WHERE m.id=$1 AND m.enabled=true AND p.enabled=true AND 'chat'=ANY(m.capabilities) LIMIT 1`, [execution.modelConfigId]);
            const model = models.rows[0];
            if (!model?.encrypted_credentials || !config.PROVIDER_ENCRYPTION_KEY || !(CHAT_COMPLETION_PROTOCOLS as readonly string[]).includes(model.protocol)) throw new Error("DISPLAY_TRANSLATION_MODEL_UNAVAILABLE");
            const credentials = JSON.parse(decryptSecret(model.encrypted_credentials, config.PROVIDER_ENCRYPTION_KEY)) as Record<string, string>;
            const connection = await options.openReceiptConnection();
            try {
                const claim = await claimDisplayTranslation(connection.cache, actor.id, parsed.data);
                if (!claim.execute) { send(claim.receipt); return; }
                receipt = claim.receipt;
                if (!await connection.confirmPersistence()) throw new Error("DISPLAY_TRANSLATION_PERSISTENCE_UNCERTAIN");
            } finally { connection.close(); }
            await reserveDisplayTranslationBudget(options.cache, actor.id, parsed.data.texts.reduce((sum, text) => sum + text.length, 0));
            reservation = await beginChatBilling(db, { requestId: `display:${receipt.hash}`, userId: actor.id, anonymous: false,
                enabled: deploymentFeatures(config).authenticationEnabled && await getCreditsEnabled(db, deploymentFeatures(config).creditsEnabled), execution });
            if (request.aborted || response.destroyed) throw new Error("DISPLAY_TRANSLATION_CANCELLED");
            const prepared = displayTranslationInput(parsed.data.texts);
            const result = await (options.complete ?? requestChatCompletion)(model, credentials, prepared.input);
            const translations = prepared.validate(result);
            settlementStarted = true;
            await finishChatBilling(db, reservation, true);
            reservation = null;
            const stored = await persist(receipt, translations);
            // Display translation is not a creative chat or generation. Audit
            // counts and transport usage without persisting the source strings.
            await writeAudit(db, { actor, action: "display.translation.completed", targetType: "model", targetId: execution.modelConfigId, result: "success",
                detail: { target: "en-US", textCount: translations.length, characters: parsed.data.texts.reduce((sum, text) => sum + text.length, 0), inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens }, ip: request.ip }).catch(() => undefined);
            send(stored);
        } catch {
            if (reservation && !settlementStarted) {
                settlementStarted = true;
                await finishChatBilling(db, reservation, false).catch(() => undefined);
            }
            if (receipt) {
                // A lost write reply can follow a committed result. Never
                // downgrade or retry a completed/uncertain provider request.
                const existing = await readDisplayTranslation(options.cache, actor.id, parsed.data).catch(() => null);
                if (existing?.status === "ready") { send(existing); return; }
                await persist(receipt).catch(() => undefined);
            }
            response.status(503).json({ error: "DISPLAY_TRANSLATION_UNAVAILABLE", message: "English display is unavailable. Your original text is preserved; no automatic retry will occur." });
        }
    });
    return router;
}
