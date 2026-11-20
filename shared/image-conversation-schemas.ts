import { z } from "zod";
import type * as Contract from "./image-conversation-contracts";

export const safeIntegerSchema = z.number().int().min(0).max(9_000_000_000_000_000);
export const positiveSequenceSchema = safeIntegerSchema.min(1);
export const uuidSchema = z.uuid();
export const requestKeySchema = z.string().min(1).max(160);
export const cursorSchema = z.string().min(1).max(2048);
export const isoDateTimeSchema = z.iso.datetime();
export const decimalMoneySchema = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/);
export const conversationEntrypointSchema = z.enum(["standalone", "canvas"]);
export const turnStateSchema = z.enum([
    "accepted",
    "planning",
    "queued",
    "generating",
    "uncertain",
    "completed",
    "failed",
    "cancelled",
    "detached",
]);
export const plannerStatusSchema = z.enum(["not_started", "in_flight", "succeeded", "failed", "unknown"]);
export const turnIntentSchema = z.enum(["discuss", "clarify", "restore", "edit", "generate_new"]);
export const attachmentPurposeSchema = z.enum(["auto", "reference", "new_base"]);
export const fixedFlareQualitySchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const flareQualitySchema = z.enum(["low", "medium", "high", "xhigh", "max", "auto"]);
export const flareResolutionSchema = z.enum(["1k", "2k", "4k"]);
export const flareComplexitySchema = z.enum(["low", "medium", "high"]);
export const staticOutputFormatSchema = z.enum(["png", "jpeg", "webp"]);
export const flareBackgroundSchema = z.enum(["transparent", "opaque", "auto"]);
export const aspectRatioSchema = z.enum([
    "1:1",
    "3:2",
    "2:3",
    "4:3",
    "3:4",
    "5:4",
    "4:5",
    "16:9",
    "9:16",
    "2:1",
    "1:2",
    "21:9",
    "9:21",
    "3:1",
    "1:3",
]);
export const exactPixelSizeSchema = z.templateLiteral([z.number(), "x", z.number()]).refine((value) => {
    if (!/^[1-9][0-9]{0,3}x[1-9][0-9]{0,3}$/.test(value)) return false;
    const [width, height] = value.split("x").map(Number);
    return (
        width % 16 === 0 &&
        height % 16 === 0 &&
        width <= 3840 &&
        height <= 3840 &&
        Math.max(width, height) <= Math.min(width, height) * 3 &&
        width * height >= 655_360 &&
        width * height <= 8_294_400
    );
}, "精确像素须为 16 的倍数，单边不超过 3840，比例不超过 3:1，总像素为 655360–8294400");
export const flareSizeSchema = z.union([aspectRatioSchema, exactPixelSizeSchema, z.literal("auto")]);
export const sizeModeSchema = z.enum(["preserve_aspect", "aspect_ratio", "exact_pixels", "provider_auto"]);
export const outputPurposeSchema = z.enum(["draft", "standard", "detail", "final"]);

const outputPreferenceFields = {
    quality: flareQualitySchema.optional(),
    resolution: flareResolutionSchema.optional(),
    size: flareSizeSchema.optional(),
    background: flareBackgroundSchema.optional(),
    outputFormat: staticOutputFormatSchema.optional(),
};

function hasCompatibleTransparency(value: Contract.ExplicitOutputPreferences) {
    return value.background !== "transparent" || value.outputFormat !== "jpeg";
}

export const outputPreferencesSchema = z
    .strictObject({ mode: z.enum(["auto", "manual"]), ...outputPreferenceFields })
    .refine(hasCompatibleTransparency, {
        path: ["outputFormat"],
        message: "透明背景仅支持 PNG 或 WebP",
    }) satisfies z.ZodType<Contract.OutputPreferences>;
export const explicitOutputPreferencesSchema = z
    .strictObject(outputPreferenceFields)
    .refine(hasCompatibleTransparency, {
        path: ["outputFormat"],
        message: "透明背景仅支持 PNG 或 WebP",
    }) satisfies z.ZodType<Contract.ExplicitOutputPreferences>;
export const turnAttachmentSchema = z.strictObject({
    assetId: uuidSchema,
    purpose: attachmentPurposeSchema.optional(),
}) satisfies z.ZodType<Contract.TurnAttachment>;

function refineTurnAttachments(attachments: readonly Contract.TurnAttachment[], context: z.RefinementCtx) {
    const purposes = new Map<string, Contract.AttachmentPurpose>();
    let explicitBases = 0;
    for (const [index, attachment] of attachments.entries()) {
        const assetId = attachment.assetId.toLowerCase(),
            purpose = attachment.purpose ?? "auto";
        if (purposes.has(assetId) && purposes.get(assetId) !== purpose) {
            context.addIssue({ code: "custom", path: [index, "purpose"], message: "同一素材不能同时指定为不同用途" });
        }
        purposes.set(assetId, purpose);
        if (purpose === "new_base" && ++explicitBases > 1) {
            context.addIssue({ code: "custom", path: [index, "purpose"], message: "每轮只能手动指定一张修改底图" });
        }
    }
}

export const createConversationRequestSchema = z
    .strictObject({
        clientRequestId: requestKeySchema,
        title: z.string().min(1).max(200).optional(),
        entrypoint: conversationEntrypointSchema,
        canvasExternalId: z.string().min(1).max(512).optional(),
        projectUuid: uuidSchema.optional(),
        initialAssetId: uuidSchema.optional(),
    })
    .superRefine((value, context) => {
        if ((value.entrypoint === "canvas") !== (value.canvasExternalId !== undefined)) {
            context.addIssue({
                code: "custom",
                path: ["canvasExternalId"],
                message: "画布会话必须提供 canvasExternalId，独立会话不能提供该字段",
            });
        }
    }) satisfies z.ZodType<Contract.CreateConversationRequest>;

const turnInputFields = {
    clientRequestId: requestKeySchema,
    expectedStateRevision: safeIntegerSchema,
    text: z.string().min(1).max(10_000).regex(/\S/, "消息必须包含非空白内容"),
};

export const submitTurnRequestSchema = z.strictObject({
    ...turnInputFields,
    attachments: z.array(turnAttachmentSchema).max(16).superRefine(refineTurnAttachments).optional(),
    replyToTurnId: uuidSchema.optional(),
    outputPreferences: outputPreferencesSchema.optional(),
}) satisfies z.ZodType<Contract.SubmitTurnRequest>;
export const acceptedTurnInputSchema = z.strictObject({
    schemaVersion: z.literal(1),
    ...turnInputFields,
    attachments: z
        .array(z.strictObject({ assetId: uuidSchema, purpose: attachmentPurposeSchema }))
        .max(16)
        .superRefine(refineTurnAttachments),
    replyToTurnId: uuidSchema.nullable(),
    outputPreferences: outputPreferencesSchema,
}) satisfies z.ZodType<Contract.AcceptedTurnInput>;
export const cancelTurnRequestSchema = z.strictObject({
    expectedStateRevision: safeIntegerSchema,
}) satisfies z.ZodType<Contract.CancelTurnRequest>;
export const paginationQuerySchema = z.strictObject({
    cursor: cursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(30),
}) satisfies z.ZodType<Contract.PaginationQuery>;
export const versionListQuerySchema = paginationQuerySchema.extend({
    rootVersionId: uuidSchema.optional(),
}) satisfies z.ZodType<Contract.VersionListQuery>;
export const eventSubscriptionQuerySchema = z.strictObject({
    afterSeq: safeIntegerSchema.default(0),
}) satisfies z.ZodType<Contract.EventSubscriptionQuery>;
export const lastEventIdSchema = z
    .string()
    .regex(/^(0|[1-9][0-9]{0,15})$/)
    .transform(Number)
    .pipe(safeIntegerSchema);

export const contextSummarySchema = z.strictObject({
    schemaVersion: z.literal(1),
    text: z.string(),
    goals: z.array(z.string()),
    unresolvedQuestions: z.array(z.string()),
}) satisfies z.ZodType<Contract.ContextSummary>;
export const requestedConstraintSchema = z.strictObject({
    key: z.string().min(1),
    text: z.string().min(1),
    source: z.enum(["user", "confirmed_plan"]),
    sourceTurnId: uuidSchema.nullable(),
}) satisfies z.ZodType<Contract.RequestedConstraint>;
export const requestedStateSchema = z.strictObject({
    schemaVersion: z.literal(1),
    goals: z.array(z.string()),
    constraints: z.array(requestedConstraintSchema),
}) satisfies z.ZodType<Contract.RequestedState>;
export const pixelDimensionsSchema = z.strictObject({
    width: positiveSequenceSchema,
    height: positiveSequenceSchema,
}) satisfies z.ZodType<Contract.PixelDimensions>;
export const imageObservationSchema = z.strictObject({
    source: z.enum(["user", "vision_check"]),
    checkedAt: isoDateTimeSchema,
    notes: z.array(z.string()),
    confidence: z.number().min(0).max(1).optional(),
    verifierModelConfigId: uuidSchema.optional(),
}) satisfies z.ZodType<Contract.ImageObservation>;
export const parameterSourceSchema = z.enum([
    "explicit_user",
    "inherited",
    "planner_intent",
    "policy",
    "admin_binding",
]);
export const parameterSourceMapSchema = z.strictObject({
    model: z.literal("admin_binding"),
    quality: parameterSourceSchema,
    resolution: parameterSourceSchema.optional(),
    size: parameterSourceSchema.optional(),
    complexity: parameterSourceSchema,
    background: parameterSourceSchema.optional(),
    output_format: parameterSourceSchema,
    n: z.literal("policy"),
}) satisfies z.ZodType<Contract.ParameterSourceMap>;
export const outputPolicyIntentSchema = z.strictObject({
    purpose: outputPurposeSchema,
    complexity: flareComplexitySchema,
    sizeMode: sizeModeSchema,
}) satisfies z.ZodType<Contract.OutputPolicyIntent>;
export const effectiveImageParametersSchema = z
    .strictObject({
        modelConfigId: uuidSchema,
        model: z.literal("gpt-image-2.6-flare"),
        n: z.literal(1),
        quality: flareQualitySchema,
        complexity: flareComplexitySchema,
        resolution: flareResolutionSchema.optional(),
        size: flareSizeSchema.optional(),
        background: flareBackgroundSchema.optional(),
        output_format: staticOutputFormatSchema,
    })
    .refine((value) => value.background !== "transparent" || value.output_format !== "jpeg", {
        path: ["output_format"],
        message: "透明背景仅支持 PNG 或 WebP",
    }) satisfies z.ZodType<Contract.EffectiveImageParameters>;
export const priceEstimateSchema = z.strictObject({
    internalCredits: z.number().min(0),
    internalRmb: decimalMoneySchema,
    providerEstimatedRmb: decimalMoneySchema.nullable(),
    providerActualRmb: decimalMoneySchema.nullable(),
    priceSource: z.string().min(1),
    priceVersion: z.string().min(1),
    reservationQuality: fixedFlareQualitySchema,
}) satisfies z.ZodType<Contract.PriceEstimate>;
export const providerUsageSchema = z.strictObject({
    inputTokens: safeIntegerSchema.optional(),
    outputTokens: safeIntegerSchema.optional(),
    totalTokens: safeIntegerSchema.optional(),
}) satisfies z.ZodType<Contract.ProviderUsage>;
export const generationActualSchema = z
    .strictObject({
        quality: fixedFlareQualitySchema.nullable(),
        dimensions: pixelDimensionsSchema,
        outputFormat: staticOutputFormatSchema,
        mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
        providerActualRmb: decimalMoneySchema.nullable(),
        usage: providerUsageSchema.nullable(),
    })
    .refine((value) => value.mimeType === `image/${value.outputFormat}`, {
        path: ["mimeType"],
        message: "实际格式与 MIME 类型必须一致",
    }) satisfies z.ZodType<Contract.GenerationActual>;

function normalizedMoney(value: string) {
    return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

export const settingsSnapshotSchema = z
    .strictObject({
        policyVersion: z.string().min(1),
        sourceMap: parameterSourceMapSchema,
        requested: outputPreferencesSchema,
        intent: outputPolicyIntentSchema,
        effective: effectiveImageParametersSchema,
        resolutionApplied: z.boolean(),
        estimate: priceEstimateSchema,
        actual: generationActualSchema.nullable(),
    })
    .superRefine((value, context) => {
        const { sizeMode } = value.intent;
        const { size, resolution, quality } = value.effective;
        if (value.resolutionApplied !== (sizeMode !== "exact_pixels")) {
            context.addIssue({
                code: "custom",
                path: ["resolutionApplied"],
                message: "精确像素忽略 resolution，其他尺寸模式必须应用 resolution",
            });
        }
        if (sizeMode !== "exact_pixels" && resolution === undefined) {
            context.addIssue({
                code: "custom",
                path: ["effective", "resolution"],
                message: "非精确像素模式必须指定分辨率",
            });
        }
        const validSize =
            sizeMode === "preserve_aspect"
                ? size === undefined
                : sizeMode === "aspect_ratio"
                  ? aspectRatioSchema.safeParse(size).success
                  : sizeMode === "exact_pixels"
                    ? exactPixelSizeSchema.safeParse(size).success
                    : size === "auto";
        if (!validSize)
            context.addIssue({ code: "custom", path: ["effective", "size"], message: "尺寸与 sizeMode 不一致" });
        if (quality === "auto" && value.estimate.reservationQuality !== "max") {
            context.addIssue({
                code: "custom",
                path: ["estimate", "reservationQuality"],
                message: "上游自动画质必须按 max 预留",
            });
        }
        const actualCost = value.actual?.providerActualRmb;
        const estimateCost = value.estimate.providerActualRmb;
        if (
            actualCost != null &&
            estimateCost != null &&
            normalizedMoney(actualCost) !== normalizedMoney(estimateCost)
        ) {
            context.addIssue({
                code: "custom",
                path: ["actual", "providerActualRmb"],
                message: "供应商实收记录必须一致",
            });
        }
    }) satisfies z.ZodType<Contract.SettingsSnapshot>;

export const imageVersionSchema = z
    .strictObject({
        id: uuidSchema,
        conversationId: uuidSchema,
        rootVersionId: uuidSchema,
        parentVersionId: uuidSchema.nullable(),
        versionNo: positiveSequenceSchema,
        imageNo: positiveSequenceSchema,
        label: z.string().min(1).max(200),
        assetId: uuidSchema,
        source: z.enum(["upload", "generated"]),
        turnId: uuidSchema.nullable(),
        outputIndex: z.literal(0),
        requestedState: requestedStateSchema,
        observation: imageObservationSchema.nullable(),
        acceptance: z.enum(["unreviewed", "accepted", "rejected"]),
        parameters: settingsSnapshotSchema.nullable(),
        actualDimensions: pixelDimensionsSchema.nullable(),
        createdAt: isoDateTimeSchema,
    })
    .superRefine((value, context) => {
        if (value.parentVersionId === null && (value.rootVersionId !== value.id || value.versionNo !== 1)) {
            context.addIssue({ code: "custom", path: ["rootVersionId"], message: "根版本必须自指向且 versionNo 为 1" });
        }
        if (
            value.parentVersionId !== null &&
            (value.rootVersionId === value.id || value.parentVersionId === value.id || value.versionNo === 1)
        ) {
            context.addIssue({
                code: "custom",
                path: ["parentVersionId"],
                message: "子版本不能自引用且 versionNo 必须大于 1",
            });
        }
        if (
            value.source === "upload" &&
            (value.turnId !== null ||
                value.parameters !== null ||
                value.parentVersionId !== null ||
                value.versionNo !== 1)
        ) {
            context.addIssue({
                code: "custom",
                path: ["source"],
                message: "上传版本必须为不带生成参数或 turnId 的根版本",
            });
        }
        if (value.source === "generated" && (value.turnId === null || value.parameters === null)) {
            context.addIssue({ code: "custom", path: ["source"], message: "生成版本必须保留 turnId 和生成参数" });
        }
    }) satisfies z.ZodType<Contract.ImageVersion>;
export const conversationMessageSchema = z
    .strictObject({
        id: uuidSchema,
        conversationId: uuidSchema,
        turnId: uuidSchema.nullable(),
        seq: positiveSequenceSchema,
        role: z.enum(["user", "assistant"]),
        kind: z.enum(["text", "image", "status"]),
        text: z.string().min(1).nullable(),
        attachments: z.array(uuidSchema),
        createdAt: isoDateTimeSchema,
    })
    .superRefine((value, context) => {
        if (value.role === "user" && value.turnId === null)
            context.addIssue({ code: "custom", path: ["turnId"], message: "用户消息必须关联 turnId" });
        if (value.kind === "image" && value.attachments.length === 0)
            context.addIssue({ code: "custom", path: ["attachments"], message: "图片消息必须关联图片版本" });
        if (value.text === null && value.attachments.length === 0)
            context.addIssue({ code: "custom", path: ["text"], message: "消息必须包含文本或图片版本" });
    }) satisfies z.ZodType<Contract.ConversationMessage>;
export const turnErrorCodeSchema = z.enum([
    "PLANNER_FAILED",
    "PLANNER_OUTCOME_UNKNOWN",
    "PLAN_INVALID",
    "ASSET_NOT_READY",
    "OUTPUT_SETTINGS_INVALID",
    "MODEL_CAPABILITY_MISMATCH",
    "MODEL_BINDING_UNAVAILABLE",
    "INSUFFICIENT_CREDITS",
    "UPSTREAM_FAILED",
    "UPSTREAM_OUTCOME_UNKNOWN",
    "RESULT_ARCHIVE_FAILED",
]);
export const turnErrorSchema = z
    .strictObject({ code: turnErrorCodeSchema, message: z.string(), retryable: z.boolean() })
    .refine(
        (value) => !["PLANNER_OUTCOME_UNKNOWN", "UPSTREAM_OUTCOME_UNKNOWN"].includes(value.code) || !value.retryable,
        {
            path: ["retryable"],
            message: "未知付费结果不能标记为可重试",
        },
    ) satisfies z.ZodType<Contract.TurnError>;
export const assistantStatusSchema = z.strictObject({
    kind: z.enum(["status", "reply", "question"]),
    text: z.string(),
    canCancel: z.boolean(),
}) satisfies z.ZodType<Contract.AssistantStatus>;
export const imageTurnSchema = z
    .strictObject({
        id: uuidSchema,
        conversationId: uuidSchema,
        clientRequestId: requestKeySchema,
        acceptedRevision: positiveSequenceSchema,
        inputActiveVersionId: uuidSchema.nullable(),
        baseVersionId: uuidSchema.nullable(),
        outputVersionId: uuidSchema.nullable(),
        replyToTurnId: uuidSchema.nullable(),
        intent: turnIntentSchema.nullable(),
        state: turnStateSchema,
        plannerStatus: plannerStatusSchema,
        taskId: uuidSchema.nullable(),
        autoActivate: z.boolean(),
        settingsSnapshot: settingsSnapshotSchema.nullable(),
        assistant: assistantStatusSchema,
        lastError: turnErrorSchema.nullable(),
        createdAt: isoDateTimeSchema,
        updatedAt: isoDateTimeSchema,
    })
    .superRefine((value, context) => {
        if (value.state === "detached" && value.autoActivate)
            context.addIssue({ code: "custom", path: ["autoActivate"], message: "已脱离轮次不能自动采用结果" });
        if (value.intent && ["discuss", "clarify", "restore"].includes(value.intent) && value.taskId !== null) {
            context.addIssue({ code: "custom", path: ["taskId"], message: "讨论、澄清和恢复不能创建生图任务" });
        }
    }) satisfies z.ZodType<Contract.ImageTurn>;

const conversationSummaryFields = {
    id: uuidSchema,
    title: z.string().min(1).max(200).nullable(),
    entrypoint: conversationEntrypointSchema,
    projectUuid: uuidSchema.nullable(),
    canvasExternalId: z.string().min(1).max(512).nullable(),
    activeVersionId: uuidSchema.nullable(),
    stateRevision: safeIntegerSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
};
export const conversationSummarySchema = z.strictObject(
    conversationSummaryFields,
) satisfies z.ZodType<Contract.ConversationSummary>;
export const conversationSnapshotSchema = z
    .strictObject({
        ...conversationSummaryFields,
        activeVersion: imageVersionSchema.nullable(),
        pendingTurn: imageTurnSchema.nullable(),
        latestEventSeq: safeIntegerSchema,
        contextSummary: contextSummarySchema,
        contextSummaryThroughSeq: safeIntegerSchema,
    })
    .refine(
        (value) =>
            value.pendingTurn === null ||
            ["accepted", "planning", "queued", "generating", "uncertain"].includes(value.pendingTurn.state),
        {
            path: ["pendingTurn"],
            message: "pendingTurn 只能包含未终结且未脱离的轮次",
        },
    ) satisfies z.ZodType<Contract.ConversationSnapshot>;
export const conversationPageSchema = z.strictObject({
    items: z.array(conversationSummarySchema).max(100),
    nextCursor: cursorSchema.nullable(),
}) satisfies z.ZodType<Contract.ConversationPage>;
export const messagePageSchema = z.strictObject({
    items: z.array(conversationMessageSchema).max(100),
    nextCursor: cursorSchema.nullable(),
}) satisfies z.ZodType<Contract.MessagePage>;
export const versionPageSchema = z.strictObject({
    items: z.array(imageVersionSchema).max(100),
    nextCursor: cursorSchema.nullable(),
}) satisfies z.ZodType<Contract.VersionPage>;
export const turnPageSchema = z.strictObject({
    items: z.array(imageTurnSchema).max(100),
    nextCursor: cursorSchema.nullable(),
}) satisfies z.ZodType<Contract.TurnPage>;
export const turnSubmissionResultSchema = z.strictObject({
    turnId: uuidSchema,
    stateRevision: safeIntegerSchema,
    state: turnStateSchema,
    assistant: assistantStatusSchema,
}) satisfies z.ZodType<Contract.TurnSubmissionResult>;
export const turnDetailsSchema = z.strictObject({
    turn: imageTurnSchema,
    stateRevision: safeIntegerSchema,
}) satisfies z.ZodType<Contract.TurnDetails>;
export const cancellationDispositionSchema = z.enum([
    "cancelled_before_submission",
    "detached_task_continues",
    "already_terminal",
]);
export const cancellationResultSchema = turnSubmissionResultSchema.extend({
    disposition: cancellationDispositionSchema,
}) satisfies z.ZodType<Contract.CancellationResult>;

const eventEnvelopeFields = {
    conversationId: uuidSchema,
    seq: positiveSequenceSchema,
    turnId: uuidSchema.nullable(),
    createdAt: isoDateTimeSchema,
};
export const conversationCreatedEventPayloadSchema = z.strictObject({
    stateRevision: safeIntegerSchema,
    conversation: conversationSummarySchema,
});
export const turnEventPayloadSchema = z.strictObject({ stateRevision: safeIntegerSchema, turn: imageTurnSchema });
export const taskProgressEventPayloadSchema = z.strictObject({
    stateRevision: safeIntegerSchema,
    turnId: uuidSchema,
    taskId: uuidSchema,
    phase: z.enum(["queued", "generating", "saving", "reconciling"]),
    progress: z.number().min(0).max(100).nullable(),
});
export const versionCreatedEventPayloadSchema = z.strictObject({
    stateRevision: safeIntegerSchema,
    version: imageVersionSchema,
});
export const activeChangedEventPayloadSchema = z.strictObject({
    stateRevision: safeIntegerSchema,
    activeVersionId: uuidSchema.nullable(),
    reason: z.enum(["initial_upload", "generation_completed", "restore"]),
});
export const messageCreatedEventPayloadSchema = z.strictObject({
    stateRevision: safeIntegerSchema,
    message: conversationMessageSchema,
});
export const contextSummaryUpdatedEventPayloadSchema = z.strictObject({
    stateRevision: safeIntegerSchema,
    contextSummary: contextSummarySchema,
    contextSummaryThroughSeq: safeIntegerSchema,
});
export const settingsResolvedEventPayloadSchema = z.strictObject({
    stateRevision: safeIntegerSchema,
    turnId: uuidSchema,
    settingsSnapshot: settingsSnapshotSchema,
});
export const turnEventTypeSchema = z.enum([
    "turn.accepted",
    "turn.updated",
    "plan.ready",
    "task.queued",
    "turn.completed",
    "turn.failed",
    "turn.cancelled",
    "turn.detached",
    "turn.uncertain",
]);
export const conversationEventSchema = z.discriminatedUnion("type", [
    z.strictObject({
        ...eventEnvelopeFields,
        type: z.literal("conversation.created"),
        payload: conversationCreatedEventPayloadSchema,
    }),
    z.strictObject({ ...eventEnvelopeFields, type: turnEventTypeSchema, payload: turnEventPayloadSchema }),
    z.strictObject({
        ...eventEnvelopeFields,
        type: z.literal("task.progress"),
        payload: taskProgressEventPayloadSchema,
    }),
    z.strictObject({
        ...eventEnvelopeFields,
        type: z.literal("version.created"),
        payload: versionCreatedEventPayloadSchema,
    }),
    z.strictObject({
        ...eventEnvelopeFields,
        type: z.literal("active.changed"),
        payload: activeChangedEventPayloadSchema,
    }),
    z.strictObject({
        ...eventEnvelopeFields,
        type: z.literal("message.created"),
        payload: messageCreatedEventPayloadSchema,
    }),
    z.strictObject({
        ...eventEnvelopeFields,
        type: z.literal("context_summary.updated"),
        payload: contextSummaryUpdatedEventPayloadSchema,
    }),
    z.strictObject({
        ...eventEnvelopeFields,
        type: z.literal("settings.resolved"),
        payload: settingsResolvedEventPayloadSchema,
    }),
]) satisfies z.ZodType<Contract.ConversationEvent>;

export const plannerModelBindingSchema = z.strictObject({
    displayName: z.literal("GPT-6.2 Sol"),
    modelConfigId: uuidSchema,
    provider: z.string().min(1),
    apiModelId: z.string().min(1),
    requiredCapabilities: z.strictObject({ vision: z.literal(true), structuredOutput: z.literal(true) }),
}) satisfies z.ZodType<Contract.PlannerModelBinding>;
export const modelRoleBindingsSchema = z.strictObject({
    planner: plannerModelBindingSchema,
    imageEdit: z.strictObject({
        modelConfigId: uuidSchema,
        provider: z.string().min(1),
        apiModelId: z.literal("gpt-image-2.6-flare"),
    }),
}) satisfies z.ZodType<Contract.ModelRoleBindings>;
export const versionSelectorSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.enum(["current", "original", "previous"]) }),
    z.strictObject({ kind: z.literal("version"), versionId: uuidSchema }),
]) satisfies z.ZodType<Contract.VersionSelector>;
export const changeDeltaSchema = z.strictObject({
    kind: z.enum(["set", "add", "remove", "relative"]),
    target: z.string().min(1),
    instruction: z.string().min(1),
}) satisfies z.ZodType<Contract.ChangeDelta>;
export const referenceRoleSchema = z.strictObject({
    versionId: uuidSchema,
    role: z.enum(["identity", "style", "composition", "text", "color", "other"]),
    instruction: z.string(),
}) satisfies z.ZodType<Contract.ReferenceRole>;
export const plannerOutputIntentSchema = z.strictObject({
    purpose: outputPurposeSchema,
    complexity: flareComplexitySchema,
    explicitPreferences: explicitOutputPreferencesSchema.optional(),
    sizeMode: sizeModeSchema.optional(),
}) satisfies z.ZodType<Contract.PlannerOutputIntent>;
export const discussPlanSchema = z.strictObject({
    action: z.literal("discuss"),
    assistantText: z.string().min(1),
}) satisfies z.ZodType<Contract.DiscussPlan>;
export const clarifyPlanSchema = z.strictObject({
    action: z.literal("clarify"),
    assistantText: z.string().min(1),
    question: z.string().min(1),
    choices: z.array(z.string().min(1)).optional(),
}) satisfies z.ZodType<Contract.ClarifyPlan>;
export const restorePlanSchema = z.strictObject({
    action: z.literal("restore"),
    assistantText: z.string().min(1),
    target: versionSelectorSchema,
}) satisfies z.ZodType<Contract.RestorePlan>;
export const editPlanSchema = z.strictObject({
    action: z.literal("edit"),
    assistantText: z.string().min(1),
    base: versionSelectorSchema,
    stateSource: z.enum(["base", "active"]),
    changes: z.array(changeDeltaSchema),
    preserve: z.array(z.string()),
    revoke: z.array(z.string()),
    references: z.array(referenceRoleSchema),
    outputIntent: plannerOutputIntentSchema,
}) satisfies z.ZodType<Contract.EditPlan>;
export const generateNewPlanSchema = z.strictObject({
    action: z.literal("generate_new"),
    assistantText: z.string().min(1),
    description: z.string().min(1),
    requestedState: requestedStateSchema,
    references: z.array(referenceRoleSchema),
    outputIntent: plannerOutputIntentSchema,
}) satisfies z.ZodType<Contract.GenerateNewPlan>;
export const plannerPlanSchema = z.discriminatedUnion("action", [
    discussPlanSchema,
    clarifyPlanSchema,
    restorePlanSchema,
    editPlanSchema,
    generateNewPlanSchema,
]) satisfies z.ZodType<Contract.PlannerPlan>;
export const contextImageEntrySchema = z.strictObject({
    versionId: uuidSchema,
    assetId: uuidSchema,
    role: z.enum(["base", "current", "original", "previous", "reference"]),
    previewed: z.boolean(),
}) satisfies z.ZodType<Contract.ContextImageEntry>;
export const contextManifestSchema = z.strictObject({
    schemaVersion: z.literal(1),
    summaryThroughSeq: safeIntegerSchema,
    messageSeqs: z.array(positiveSequenceSchema),
    inputActiveVersionId: uuidSchema.nullable(),
    baseVersionId: uuidSchema.nullable(),
    sourceStateVersionId: uuidSchema.nullable(),
    images: z.array(contextImageEntrySchema),
    attachments: z
        .array(z.strictObject({ assetId: uuidSchema, versionId: uuidSchema, purpose: attachmentPurposeSchema }))
        .superRefine(refineTurnAttachments),
    omittedHistory: z.boolean(),
    policyVersion: z.string().min(1),
}) satisfies z.ZodType<Contract.ContextManifest>;
export const plannerDispatchFenceSchema = z.strictObject({
    plannerRequestId: requestKeySchema,
    plannerDispatchStartedAt: isoDateTimeSchema,
    leaseToken: uuidSchema,
    leaseExpiresAt: isoDateTimeSchema,
    executionEpoch: safeIntegerSchema,
}) satisfies z.ZodType<Contract.PlannerDispatchFence>;
export const imageTaskBindingSchema = z.strictObject({
    taskId: uuidSchema,
    taskRequestId: requestKeySchema,
    imageModelConfigId: uuidSchema,
    imageModelId: z.literal("gpt-image-2.6-flare"),
    canvasExternalId: z.string().min(1).max(512).nullable(),
}) satisfies z.ZodType<Contract.ImageTaskBinding>;
