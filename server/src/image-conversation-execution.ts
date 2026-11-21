import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { compileConversationImagePrompt, resolveConversationVersion } from "../../shared/image-agent/conversation";
import { MARK_IMAGE_PROVIDER_ID } from "../../shared/mark-image-models";
import type { ContextManifest, ImageVersion, VersionSelector } from "../../shared/image-conversation-contracts";
import {
    acceptedTurnInputSchema,
    contextManifestSchema,
    plannerPlanSchema,
} from "../../shared/image-conversation-schemas";
import { preflightApiMartImageRequest } from "./apimart-image";
import { loadTaskPriceSnapshot } from "./billing";
import type { Database } from "./db";
import {
    ImageOutputPolicyError,
    resolveEffectiveImageParameters,
    type ImageOutputPolicyInput,
} from "./image-output-policy";
import { hasImageTransparency } from "./image-result-processing";
import { probeMediaBytes } from "./media-probe";
import type { ObjectStorage } from "./object-storage";
import { providerImageMimeType } from "./provider-image-result";
import { prepareTaskEnqueue } from "./tasks";
import { readToolConfiguration, resolveToolExecution } from "./tool-configuration";
import { mapUser, userSelect, type UserRow } from "./user-mapper";
import {
    canonicalPayloadHash,
    ImageConversationError,
    readVersion,
    versionSnapshot,
    type VersionRow,
} from "./image-conversation-store";
import { createConversationTaskSnapshot } from "./image-conversation-task";
import type { ConversationExecution, PreparedConversationImage } from "./image-conversation-worker";

type Query = Pick<Database, "query">;
type SourceAsset = {
    id: string;
    owner_user_id: string;
    object_key: string;
    mime_type: string;
    byte_size: string | number;
    content_sha256: string | null;
};
type ImageModel = {
    id: string;
    providerId: string;
    modelId: string;
    protocol: string;
    enabled: boolean;
    providerEnabled: boolean;
    workflowConfigId: string | null;
    capabilities: string[];
    modelUpdatedAt: string;
    providerUpdatedAt: string;
    baseUrl: string;
};
export type ImageConversationExecutionOptions = {
    storage?: Pick<ObjectStorage, "get">;
    readAsset?: (asset: Readonly<SourceAsset>) => Promise<Uint8Array>;
    creditsEnabled: (client?: Query) => Promise<boolean>;
    maxInflightTasks?: number;
    maxPausedTasks?: number;
    outputLimits?: ImageOutputPolicyInput["limits"];
};

function executionManifest(execution: ConversationExecution) {
    const input = acceptedTurnInputSchema.parse(execution.turn.input_payload);
    const manifest = contextManifestSchema.parse(execution.turn.context_manifest);
    const requested = input.attachments.find((attachment) => attachment.purpose === "new_base");
    const recorded = manifest.attachments.find((attachment) => attachment.purpose === "new_base");
    if (requested?.assetId !== recorded?.assetId) {
        throw new ImageConversationError(
            422,
            "VALIDATION_ERROR",
            "手动指定的底图与已受理附件记录不一致，本轮未执行图片操作",
        );
    }
    return manifest;
}

function assertManualBase(manifest: ContextManifest, base: ImageVersion | null) {
    const selected = manifest.attachments.find((attachment) => attachment.purpose === "new_base");
    if (selected && (base?.id !== selected.versionId || base.assetId !== selected.assetId)) {
        throw new ImageConversationError(
            422,
            "VALIDATION_ERROR",
            "规划与手动指定的底图冲突，请确认底图或清除手动选择；本轮未执行图片操作",
        );
    }
}

export async function readConversationActor(db: Query, ownerId: string) {
    const row = (
        await db.query<UserRow>(
            `SELECT ${userSelect} FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=$1`,
            [ownerId],
        )
    ).rows[0];
    if (!row || row.status !== "active" || row.must_change_password)
        throw new ImageConversationError(403, "ACCOUNT_NOT_READY", "账号当前不可执行新任务");
    return mapUser(row);
}

async function executionVersions(
    db: Query,
    execution: ConversationExecution,
    selector: VersionSelector | null,
    references: string[] = [],
) {
    const ids = new Set(
        [
            execution.turn.input_active_version_id,
            selector?.kind === "version" ? selector.versionId : null,
            ...references,
        ].filter((id): id is string => Boolean(id)),
    );
    const rows = await db.query<VersionRow>(
        "SELECT * FROM image_conversation_versions WHERE conversation_id=$1 AND id=ANY($2::uuid[])",
        [execution.conversation.id, [...ids]],
    );
    if (rows.rows.length !== ids.size)
        throw new ImageConversationError(404, "NOT_FOUND", "计划引用的图片版本不属于本会话");
    const relatives = new Set(
        rows.rows
            .flatMap((row) => [row.root_version_id, row.parent_version_id])
            .filter((id): id is string => Boolean(id) && !ids.has(id!)),
    );
    if (relatives.size)
        rows.rows.push(
            ...(
                await db.query<VersionRow>(
                    "SELECT * FROM image_conversation_versions WHERE conversation_id=$1 AND id=ANY($2::uuid[])",
                    [execution.conversation.id, [...relatives]],
                )
            ).rows,
        );
    return rows.rows.map(versionSnapshot);
}

async function imageExecution(
    db: Query,
    execution: ConversationExecution,
    operationType: "inpaint" | "image_generation",
) {
    const binding = await readToolConfiguration(db, "gpt-chat-image");
    if (!binding.enabled || !binding.modelConfigId)
        throw new ImageConversationError(503, "MODEL_BINDING_UNAVAILABLE", "管理员尚未启用对话图片模型绑定");
    const toolKey =
        execution.conversation.entrypoint === "standalone"
            ? "gpt-chat-image"
            : operationType === "inpaint"
              ? "canvas-edit"
              : "canvas-image";
    const tool = await resolveToolExecution(
        db,
        { toolKey, operationType, modelConfigId: binding.modelConfigId },
        { allowModelOverride: true },
    );
    const model = (
        await db.query<ImageModel>(
            `SELECT m.id,m.provider_id AS "providerId",m.model_id AS "modelId",m.enabled,m.capabilities,
    m.workflow_config_id AS "workflowConfigId",m.updated_at::text AS "modelUpdatedAt",p.protocol,p.base_url AS "baseUrl",p.enabled AS "providerEnabled",p.updated_at::text AS "providerUpdatedAt"
    FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.id=$1`,
            [tool.modelConfigId],
        )
    ).rows[0];
    if (
        !model ||
        model.id !== binding.modelConfigId ||
        model.providerId !== MARK_IMAGE_PROVIDER_ID ||
        model.modelId !== "gpt-image-2.6-flare" ||
        model.protocol !== "apimart" ||
        !model.enabled ||
        !model.providerEnabled ||
        model.workflowConfigId ||
        !model.capabilities.includes(operationType === "inpaint" ? "edit" : "generate")
    ) {
        throw new ImageConversationError(
            422,
            "MODEL_CAPABILITY_MISMATCH",
            "对话图片角色必须绑定已启用的 APIMart Flare 生图与编辑模型，不会自动更换通道",
        );
    }
    return { binding, tool, model };
}

async function sourceAsset(db: Query, ownerId: string, version: ImageVersion, lock = false) {
    const asset = (
        await db.query<SourceAsset>(
            `SELECT id,owner_user_id,object_key,mime_type,byte_size,content_sha256 FROM assets
    WHERE id=$1 AND owner_user_id=$2 AND status='ready' AND kind='image' AND deleted_at IS NULL${lock ? " FOR SHARE" : ""}`,
            [version.assetId, ownerId],
        )
    ).rows[0];
    const size = Number(asset?.byte_size);
    if (
        !asset ||
        !asset.object_key ||
        !["image/png", "image/jpeg", "image/webp"].includes(asset.mime_type) ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > 50 * 1024 * 1024
    ) {
        throw new ImageConversationError(
            422,
            "ASSET_NOT_READY",
            "底图或参考图未就绪；当前编辑支持不超过 50 MiB 的 PNG、JPEG、WebP 原件",
        );
    }
    return asset;
}

async function readSource(asset: SourceAsset, options: ImageConversationExecutionOptions) {
    if (options.readAsset) return options.readAsset(Object.freeze({ ...asset }));
    if (!options.storage) throw new ImageConversationError(503, "SERVICE_UNAVAILABLE", "原图存储不可用");
    const object = await options.storage.get(asset.object_key, { abortSignal: AbortSignal.timeout(30_000) });
    if (
        !object.Body ||
        !object.ETag ||
        object.ContentLength !== Number(asset.byte_size) ||
        object.ContentType?.split(";", 1)[0] !== asset.mime_type
    )
        throw new ImageConversationError(422, "ASSET_NOT_READY", "原图存储身份已变化");
    return object.Body.transformToByteArray();
}

async function verifiedSource(
    db: Query,
    ownerId: string,
    version: ImageVersion,
    options: ImageConversationExecutionOptions,
) {
    const asset = await sourceAsset(db, ownerId, version);
    const bytes = await readSource(asset, options);
    const mimeType = providerImageMimeType(bytes, "");
    if (
        bytes.byteLength !== Number(asset.byte_size) ||
        mimeType !== asset.mime_type ||
        (asset.content_sha256 && createHash("sha256").update(bytes).digest("hex") !== asset.content_sha256)
    ) {
        throw new ImageConversationError(422, "ASSET_NOT_READY", "原图内容与持久素材记录不一致");
    }
    try {
        await hasImageTransparency({ bytes, mimeType });
        const metadata = await probeMediaBytes(bytes, mimeType);
        if (!metadata.width || !metadata.height) throw new Error("Image dimensions unavailable");
        return { asset, bytes, mimeType, dimensions: { width: metadata.width, height: metadata.height } };
    } catch {
        throw new ImageConversationError(422, "ASSET_NOT_READY", "原图无法完整解码或不是受支持的静态图片");
    }
}

export async function resolveConversationRestore(
    db: Database,
    execution: ConversationExecution,
    options: ImageConversationExecutionOptions,
) {
    const plan = plannerPlanSchema.parse(execution.turn.plan);
    if (plan.action !== "restore") throw new Error("Restore requires a restore plan");
    const manifest = executionManifest(execution);
    const versions = await executionVersions(db, execution, plan.target);
    const target = resolveConversationVersion(versions, execution.turn.input_active_version_id, plan.target);
    assertManualBase(manifest, target);
    await verifiedSource(db, execution.conversation.owner_user_id, target, options);
    return target.id;
}

export async function prepareConversationImage(
    db: Database,
    execution: ConversationExecution,
    options: ImageConversationExecutionOptions,
): Promise<
    PreparedConversationImage | { clarification: { action: "clarify"; assistantText: string; question: string } }
> {
    const plan = plannerPlanSchema.parse(execution.turn.plan);
    if (plan.action !== "edit" && plan.action !== "generate_new") throw new Error("Image task requires an image plan");
    const previousManifest = executionManifest(execution);
    const ownerId = execution.conversation.owner_user_id;
    const actor = await readConversationActor(db, ownerId);
    const versions = await executionVersions(
        db,
        execution,
        plan.action === "edit" ? plan.base : null,
        plan.references.map((reference) => reference.versionId),
    );
    const base =
        plan.action === "edit"
            ? resolveConversationVersion(versions, execution.turn.input_active_version_id, plan.base)
            : null;
    assertManualBase(previousManifest, base);
    const sourceStateVersion =
        plan.action === "edit"
            ? plan.stateSource === "active"
                ? (versions.find((version) => version.id === execution.turn.input_active_version_id) ?? null)
                : base
            : null;
    if (plan.action === "edit" && !sourceStateVersion)
        throw new ImageConversationError(422, "VALIDATION_ERROR", "要继承的设计状态不存在，请说明使用哪张图的要求");
    const compiled = compileConversationImagePrompt({
        plan,
        versions,
        base,
        sourceStateVersion,
        sourceState: sourceStateVersion?.requestedState ?? null,
        turnId: execution.turn.id,
        userText: execution.turn.input_payload.text,
    });
    const sources: Awaited<ReturnType<typeof verifiedSource>>[] = [];
    for (const source of compiled.sources) sources.push(await verifiedSource(db, ownerId, source, options));
    const operationType = plan.action === "edit" ? "inpaint" : "image_generation";
    const selected = await imageExecution(db, execution, operationType);
    const creditsEnabled = await options.creditsEnabled();
    const price = await loadTaskPriceSnapshot(db, {
        operationType,
        modelConfigId: selected.tool.modelConfigId,
        toolConfiguration: selected.tool,
        quantity: 1,
        creditsEnabled,
    });
    let settings;
    try {
        settings = resolveEffectiveImageParameters({
            action: plan.action,
            requested: execution.turn.input_payload.outputPreferences,
            intent: plan.outputIntent,
            ...(base ? { base: { parameters: base.parameters, actualDimensions: sources[0]!.dimensions } } : {}),
            binding: {
                modelConfigId: selected.model.id,
                apiModelId: "gpt-image-2.6-flare",
                provider: selected.model.providerId,
                providerProtocol: selected.model.protocol,
                enabled: true,
            },
            priceSnapshot: price,
            limits: options.outputLimits,
        });
    } catch (error) {
        if (error instanceof ImageOutputPolicyError && error.clarificationRequired)
            return { clarification: { action: "clarify", assistantText: error.message, question: error.message } };
        throw error;
    }
    const { modelConfigId: _modelConfigId, model: _model, ...parameters } = settings.effective;
    preflightApiMartImageRequest({
        modelId: selected.model.modelId,
        prompt: compiled.prompt,
        parameters,
        sourceImages: sources.map((source) => ({ bytes: source.bytes, mimeType: source.mimeType })),
    });
    const imageManifest = new Map(previousManifest.images.map((image) => [image.versionId, image]));
    for (const source of compiled.sources)
        imageManifest.set(source.id, {
            versionId: source.id,
            assetId: source.assetId,
            role: source.id === base?.id ? "base" : "reference",
            previewed: imageManifest.get(source.id)?.previewed ?? false,
        });
    const manifest: ContextManifest = {
        ...previousManifest,
        baseVersionId: base?.id ?? null,
        sourceStateVersionId: sourceStateVersion?.id ?? null,
        images: [...imageManifest.values()],
    };
    const sourceUrls = compiled.sources.map((source) => `/api/assets/${source.assetId}/content`);
    const conversationInput = createConversationTaskSnapshot({
        turnId: execution.turn.id,
        modelConfigId: selected.model.id,
        providerId: selected.model.providerId,
        baseUrl: selected.model.baseUrl,
        prompt: compiled.prompt,
        parameters,
        operationType,
        sourceUrls,
        sources: sources.map((source) => ({
            assetId: source.asset.id,
            bytes: source.bytes,
            mimeType: source.mimeType,
        })),
    });
    const task = await prepareTaskEnqueue(db, {
        requestId: `ic:${execution.turn.id}:image:1`,
        userId: ownerId,
        departmentId: actor.departmentId,
        projectId: execution.conversation.canvas_external_id ?? "",
        operationType,
        toolKey: selected.tool.toolKey,
        toolConfiguration: selected.tool,
        modelConfigId: selected.tool.modelConfigId,
        prompt: compiled.prompt,
        sourceUrls,
        parameters: { ...parameters, conversationInput },
        priority: "normal",
        creditsEnabled,
        maxInflightTasks: options.maxInflightTasks,
        maxPausedTasks: options.maxPausedTasks,
        priceSnapshot: price,
        optimized: false,
    });
    const selectedHash = canonicalPayloadHash(selected);
    const priceHash = canonicalPayloadHash(price);
    return {
        task,
        settings,
        manifest,
        validate: async (client: PoolClient) => {
            await client.query("SELECT id FROM users WHERE id=$1 FOR SHARE", [ownerId]);
            await client.query(
                "SELECT tool_key FROM tool_api_configurations WHERE tool_key=ANY($1::text[]) ORDER BY tool_key FOR SHARE",
                [["gpt-chat-image", "gpt-chat", "canvas", selected.tool.toolKey]],
            );
            await client.query(
                "SELECT module_key FROM module_flags WHERE module_key=ANY($1::text[]) ORDER BY module_key FOR SHARE",
                [["gpt-chat-image", "gpt-chat", "canvas", selected.tool.toolKey]],
            );
            await client.query(
                "SELECT m.id FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.id=$1 FOR SHARE OF m,p",
                [selected.model.id],
            );
            await client.query(
                "SELECT id FROM pricing_rule_versions WHERE operation_type=$1 AND status='published' FOR SHARE",
                [operationType],
            );
            await client.query("SELECT singleton FROM credit_policy WHERE singleton=true FOR SHARE");
            const currentActor = await readConversationActor(client, ownerId);
            if (currentActor.departmentId !== actor.departmentId)
                throw new ImageConversationError(409, "ACCOUNT_NOT_READY", "账号归属已变化，请重新发送需求");
            const current = await imageExecution(client, execution, operationType);
            if (canonicalPayloadHash(current) !== selectedHash)
                throw new ImageConversationError(409, "MODEL_BINDING_UNAVAILABLE", "图片模型配置已变化，尚未提交生成");
            const currentCreditsEnabled = await options.creditsEnabled(client);
            if (currentCreditsEnabled !== creditsEnabled)
                throw new ImageConversationError(409, "PRICE_UNAVAILABLE", "计费策略已变化，尚未提交生成");
            const currentPrice = await loadTaskPriceSnapshot(client, {
                operationType,
                modelConfigId: current.tool.modelConfigId,
                toolConfiguration: current.tool,
                quantity: 1,
                creditsEnabled: currentCreditsEnabled,
            });
            if (canonicalPayloadHash(currentPrice) !== priceHash)
                throw new ImageConversationError(409, "PRICE_UNAVAILABLE", "图片费用配置已变化，尚未提交生成");
            for (const [index, version] of compiled.sources.entries()) {
                const currentVersion = versionSnapshot(
                    await readVersion(client, execution.conversation.id, version.id),
                );
                if (
                    canonicalPayloadHash(currentVersion) !== canonicalPayloadHash(version) ||
                    canonicalPayloadHash(await sourceAsset(client, ownerId, currentVersion, true)) !==
                        canonicalPayloadHash(sources[index]!.asset)
                ) {
                    throw new ImageConversationError(422, "ASSET_NOT_READY", "底图或参考素材已变化，尚未提交生成");
                }
            }
        },
    };
}
