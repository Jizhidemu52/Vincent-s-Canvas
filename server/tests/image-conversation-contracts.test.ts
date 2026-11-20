import { describe, expect, test } from "bun:test";
import type {
    AcceptedTurnInput,
    ContextManifest,
    ConversationEvent,
    ConversationMessage,
    CreateConversationRequest,
    ImageTurn,
    ImageVersion,
    ModelRoleBindings,
    PlannerPlan,
    SettingsSnapshot,
} from "../../shared/image-conversation-contracts";
import {
    acceptedTurnInputSchema,
    cancelTurnRequestSchema,
    contextManifestSchema,
    conversationEventSchema,
    conversationMessageSchema,
    conversationSnapshotSchema,
    createConversationRequestSchema,
    decimalMoneySchema,
    eventSubscriptionQuerySchema,
    exactPixelSizeSchema,
    generationActualSchema,
    imageTurnSchema,
    imageVersionSchema,
    lastEventIdSchema,
    modelRoleBindingsSchema,
    outputPreferencesSchema,
    paginationQuerySchema,
    plannerPlanSchema,
    requestedStateSchema,
    safeIntegerSchema,
    settingsSnapshotSchema,
    submitTurnRequestSchema,
    turnErrorSchema,
    versionListQuerySchema,
} from "../../shared/image-conversation-schemas";

const conversationId = "c1e00000-0000-4000-8000-000000000001";
const turnId = "c1e00000-0000-4000-8000-000000000002";
const versionId = "c1e00000-0000-4000-8000-000000000003";
const assetId = "c1e00000-0000-4000-8000-000000000004";
const modelConfigId = "c1e00000-0000-4000-8000-000000000005";
const now = "2026-11-19T00:00:00.000Z";
const requestedState = {
    schemaVersion: 1 as const,
    goals: ["蓝色外套"],
    constraints: [{ key: "color", text: "外套为蓝色", source: "user" as const, sourceTurnId: turnId }],
};

function settings(): SettingsSnapshot {
    return {
        policyVersion: "conversation-v1",
        sourceMap: {
            model: "admin_binding",
            quality: "policy",
            resolution: "policy",
            complexity: "planner_intent",
            output_format: "policy",
            n: "policy",
        },
        requested: { mode: "auto" },
        intent: { purpose: "standard", complexity: "low", sizeMode: "preserve_aspect" },
        effective: {
            modelConfigId,
            model: "gpt-image-2.6-flare",
            n: 1,
            quality: "high",
            complexity: "low",
            resolution: "2k",
            output_format: "png",
        },
        resolutionApplied: true,
        estimate: {
            internalCredits: 3,
            internalRmb: "0.03",
            providerEstimatedRmb: null,
            providerActualRmb: null,
            priceSource: "internal:configured;provider:unknown",
            priceVersion: "test-v1",
            reservationQuality: "high",
        },
        actual: null,
    };
}

function turn(): ImageTurn {
    return {
        id: turnId,
        conversationId,
        clientRequestId: "request/大小写-A",
        acceptedRevision: 1,
        inputActiveVersionId: versionId,
        baseVersionId: null,
        outputVersionId: null,
        replyToTurnId: null,
        intent: null,
        state: "accepted",
        plannerStatus: "not_started",
        taskId: null,
        autoActivate: true,
        settingsSnapshot: null,
        assistant: { kind: "status", text: "已接收", canCancel: true },
        lastError: null,
        createdAt: now,
        updatedAt: now,
    };
}

function uploadVersion(): ImageVersion {
    return {
        id: versionId,
        conversationId,
        rootVersionId: versionId,
        parentVersionId: null,
        versionNo: 1,
        imageNo: 1,
        label: "原图",
        assetId,
        source: "upload",
        turnId: null,
        outputIndex: 0,
        requestedState,
        observation: null,
        acceptance: "unreviewed",
        parameters: null,
        actualDimensions: { width: 300, height: 200 },
        createdAt: now,
    };
}

describe("conversation request contract", () => {
    test("keeps opaque request keys, external canvas IDs and explicit text unchanged", () => {
        const request: CreateConversationRequest = {
            clientRequestId: "  Canvas/大小写:A?b  ",
            entrypoint: "canvas",
            canvasExternalId: "canvas-not-a-uuid",
            projectUuid: conversationId,
            initialAssetId: assetId,
        };
        expect(createConversationRequestSchema.parse(request)).toEqual(request);
        const input = {
            clientRequestId: " request ",
            expectedStateRevision: 0,
            text: "  保留颜色\n  ",
            attachments: [{ assetId }],
        };
        expect(submitTurnRequestSchema.parse(input)).toEqual(input);
    });

    test("requires canvas external ID only for canvas entrypoints", () => {
        expect(
            createConversationRequestSchema.safeParse({ clientRequestId: "one", entrypoint: "standalone" }).success,
        ).toBe(true);
        expect(
            createConversationRequestSchema.safeParse({ clientRequestId: "one", entrypoint: "canvas" }).success,
        ).toBe(false);
        expect(
            createConversationRequestSchema.safeParse({
                clientRequestId: "one",
                entrypoint: "standalone",
                canvasExternalId: "canvas",
            }).success,
        ).toBe(false);
    });

    test.each([
        "userId",
        "model",
        "modelConfigId",
        "baseImageId",
        "provider",
        "apiKey",
    ])("rejects public field %s", (field) => {
        expect(
            createConversationRequestSchema.safeParse({
                clientRequestId: "one",
                entrypoint: "standalone",
                [field]: "injected",
            }).success,
        ).toBe(false);
        expect(
            submitTurnRequestSchema.safeParse({
                clientRequestId: "one",
                expectedStateRevision: 0,
                text: "修改",
                [field]: "injected",
            }).success,
        ).toBe(false);
    });

    test("enforces each request string boundary and UUID format", () => {
        const base = {
            clientRequestId: "r".repeat(160),
            entrypoint: "canvas",
            canvasExternalId: "c".repeat(512),
            title: "t".repeat(200),
            initialAssetId: assetId,
        };
        expect(createConversationRequestSchema.safeParse(base).success).toBe(true);
        for (const change of [
            { clientRequestId: "" },
            { clientRequestId: "r".repeat(161) },
            { title: "" },
            { title: "t".repeat(201) },
            { canvasExternalId: "" },
            { canvasExternalId: "c".repeat(513) },
            { projectUuid: "not-uuid" },
            { initialAssetId: "not-uuid" },
        ]) {
            expect(createConversationRequestSchema.safeParse({ ...base, ...change }).success).toBe(false);
        }
        const input = { clientRequestId: "turn", expectedStateRevision: 0, text: "字".repeat(10_000) };
        expect(submitTurnRequestSchema.safeParse(input).success).toBe(true);
        for (const text of ["", " \t\n\u3000", "字".repeat(10_001)])
            expect(submitTurnRequestSchema.safeParse({ ...input, text }).success).toBe(false);
    });

    test("accepts at most 16 strictly shaped asset attachments", () => {
        const input = {
            clientRequestId: "turn",
            expectedStateRevision: 0,
            text: "修改",
            attachments: Array.from({ length: 16 }, () => ({ assetId, purpose: "reference" })),
        };
        expect(submitTurnRequestSchema.safeParse(input).success).toBe(true);
        expect(
            submitTurnRequestSchema.safeParse({ ...input, attachments: [...input.attachments, { assetId }] }).success,
        ).toBe(false);
        for (const attachment of [
            { assetId, purpose: "source" },
            { assetId, url: "https://untrusted.example/image.png" },
            { assetId: "bad" },
        ]) {
            expect(submitTurnRequestSchema.safeParse({ ...input, attachments: [attachment] }).success).toBe(false);
        }
    });

    test("requires durable normalized defaults, without adding execution preferences", () => {
        const input: AcceptedTurnInput = {
            schemaVersion: 1,
            clientRequestId: "turn",
            expectedStateRevision: 0,
            text: "修改",
            attachments: [{ assetId, purpose: "auto" }],
            replyToTurnId: null,
            outputPreferences: { mode: "auto" },
        };
        expect(acceptedTurnInputSchema.parse(input)).toEqual(input);
        for (const field of ["schemaVersion", "attachments", "replyToTurnId", "outputPreferences"] as const) {
            const broken: Partial<AcceptedTurnInput> = { ...input };
            delete broken[field];
            expect(acceptedTurnInputSchema.safeParse(broken).success).toBe(false);
        }
        expect(acceptedTurnInputSchema.safeParse({ ...input, attachments: [{ assetId }] }).success).toBe(false);
        expect(
            acceptedTurnInputSchema.safeParse({ ...input, outputPreferences: { mode: "auto", apiKey: "not-allowed" } })
                .success,
        ).toBe(false);
    });

    test("one explicit base is allowed, while multiple bases and conflicting roles for one asset are rejected", () => {
        const request = { clientRequestId: "manual-base", expectedStateRevision: 0, text: "基于所选图片修改" };
        const accepted = { ...request, schemaVersion: 1, replyToTurnId: null, outputPreferences: { mode: "auto" } };
        const valid = [
            { assetId, purpose: "new_base" },
            { assetId: modelConfigId, purpose: "reference" },
        ];
        expect(submitTurnRequestSchema.safeParse({ ...request, attachments: valid }).success).toBe(true);
        expect(acceptedTurnInputSchema.safeParse({ ...accepted, attachments: valid }).success).toBe(true);
        for (const attachments of [
            [
                { assetId, purpose: "new_base" },
                { assetId: modelConfigId, purpose: "new_base" },
            ],
            [
                { assetId, purpose: "new_base" },
                { assetId, purpose: "new_base" },
            ],
            [
                { assetId, purpose: "new_base" },
                { assetId, purpose: "reference" },
            ],
            [
                { assetId, purpose: "auto" },
                { assetId: assetId.toUpperCase(), purpose: "reference" },
            ],
        ]) {
            expect(submitTurnRequestSchema.safeParse({ ...request, attachments }).success).toBe(false);
            expect(acceptedTurnInputSchema.safeParse({ ...accepted, attachments }).success).toBe(false);
        }
        expect(
            submitTurnRequestSchema.safeParse({
                ...request,
                attachments: [{ assetId }, { assetId, purpose: "new_base" }],
            }).success,
        ).toBe(false);
    });

    test("cancellation requires a strict revision request", () => {
        expect(cancelTurnRequestSchema.parse({ expectedStateRevision: 0 })).toEqual({ expectedStateRevision: 0 });
        expect(cancelTurnRequestSchema.safeParse({}).success).toBe(false);
        expect(cancelTurnRequestSchema.safeParse({ expectedStateRevision: 0, refund: true }).success).toBe(false);
    });
});

describe("safe integers and replay cursors", () => {
    test.each([0, 1, 9_000_000_000_000_000])("accepts safe integer %s", (value) =>
        expect(safeIntegerSchema.parse(value)).toBe(value));
    test.each([-1, 0.1, NaN, Infinity, 9_000_000_000_000_001, "1", null, true])("rejects unsafe value %s", (value) =>
        expect(safeIntegerSchema.safeParse(value).success).toBe(false));
    test("validates numeric pagination and supplies only documented defaults", () => {
        expect(paginationQuerySchema.parse({})).toEqual({ limit: 30 });
        expect(eventSubscriptionQuerySchema.parse({})).toEqual({ afterSeq: 0 });
        expect(versionListQuerySchema.parse({ rootVersionId: versionId, cursor: "opaque", limit: 100 })).toEqual({
            rootVersionId: versionId,
            cursor: "opaque",
            limit: 100,
        });
        for (const limit of [0, 101, 1.5, "30", null, true])
            expect(paginationQuerySchema.safeParse({ limit }).success).toBe(false);
        for (const cursor of ["", "c".repeat(2049)])
            expect(paginationQuerySchema.safeParse({ cursor }).success).toBe(false);
        expect(paginationQuerySchema.safeParse({ cursor: "c".repeat(2048) }).success).toBe(true);
        expect(eventSubscriptionQuerySchema.safeParse({ afterSeq: "0" }).success).toBe(false);
        expect(eventSubscriptionQuerySchema.safeParse({ afterSeq: 0, ownerId: conversationId }).success).toBe(false);
    });
    test.each([
        "",
        "01",
        "+1",
        "-1",
        "1.0",
        "1e2",
        " 1",
        "1 ",
        "9000000000000001",
        "99999999999999999",
    ])("rejects malformed Last-Event-ID %s", (value) => expect(lastEventIdSchema.safeParse(value).success).toBe(false));
    test("parses the complete valid replay range", () => {
        expect(lastEventIdSchema.parse("0")).toBe(0);
        expect(lastEventIdSchema.parse("9000000000000000")).toBe(9_000_000_000_000_000);
    });
});

describe("static Flare output settings", () => {
    test.each([
        "1024x640",
        "640x1024",
        "1536x512",
        "512x1536",
        "3840x2160",
        "2160x3840",
        "1600x1200",
    ])("accepts exact pixel boundary %s", (size) => expect(exactPixelSizeSchema.parse(size)).toBe(size));
    test.each([
        "1023x640",
        "1024x624",
        "3840x2176",
        "3856x2144",
        "1552x512",
        "0x1024",
        "-1024x1024",
        "01024x1024",
        "1024.0x1024",
        "1024X1024",
        "1024 x 1024",
        "1e3x1024",
        "1:1",
        "auto",
        "3840x3840",
    ])("rejects invalid exact pixels %s", (size) => expect(exactPixelSizeSchema.safeParse(size).success).toBe(false));
    test("keeps product auto separate from explicit provider auto", () => {
        expect(outputPreferencesSchema.parse({ mode: "auto" })).toEqual({ mode: "auto" });
        expect(
            outputPreferencesSchema.parse({ mode: "auto", quality: "auto", resolution: "4k", size: "3840x2160" }),
        ).toEqual({ mode: "auto", quality: "auto", resolution: "4k", size: "3840x2160" });
    });
    test.each([
        { resolution: "auto" },
        { outputFormat: "gif" },
        { outputFormat: "svg" },
        { output_compression: 90 },
        { quality: "ultra" },
        { background: "transparent", outputFormat: "jpeg" },
    ])("rejects unsupported preference %j", (extra) =>
        expect(outputPreferencesSchema.safeParse({ mode: "auto", ...extra }).success).toBe(false));
    test("transparent format can be resolved later, but cannot explicitly be JPEG", () => {
        expect(outputPreferencesSchema.safeParse({ mode: "auto", background: "transparent" }).success).toBe(true);
        for (const outputFormat of ["png", "webp"])
            expect(
                outputPreferencesSchema.safeParse({ mode: "manual", background: "transparent", outputFormat }).success,
            ).toBe(true);
    });
    test("supports each exact settings mode", () => {
        const preserved = settings();
        const ratio = settings();
        ratio.intent.sizeMode = "aspect_ratio";
        ratio.effective.size = "16:9";
        const exact = settings();
        exact.intent.sizeMode = "exact_pixels";
        exact.effective.size = "3840x2160";
        exact.resolutionApplied = false;
        delete exact.effective.resolution;
        const automatic = settings();
        automatic.intent.sizeMode = "provider_auto";
        automatic.effective.size = "auto";
        for (const value of [preserved, ratio, exact, automatic])
            expect(settingsSnapshotSchema.parse(value)).toEqual(value);
        exact.effective.resolution = "1k";
        expect(settingsSnapshotSchema.safeParse(exact).success).toBe(true);
    });
    test("rejects inconsistent mode/size/resolution flags", () => {
        const preserve = settings();
        preserve.effective.size = "1:1";
        const missingResolution = settings();
        delete missingResolution.effective.resolution;
        const ratio = settings();
        ratio.intent.sizeMode = "aspect_ratio";
        ratio.effective.size = "1024x1024";
        const exact = settings();
        exact.intent.sizeMode = "exact_pixels";
        exact.effective.size = "1024x1024";
        const wrongExact = settings();
        wrongExact.intent.sizeMode = "exact_pixels";
        wrongExact.effective.size = "1:1";
        wrongExact.resolutionApplied = false;
        const automatic = settings();
        automatic.intent.sizeMode = "provider_auto";
        automatic.effective.size = "16:9";
        const wrongApplied = settings();
        wrongApplied.resolutionApplied = false;
        for (const value of [preserve, missingResolution, ratio, exact, wrongExact, automatic, wrongApplied])
            expect(settingsSnapshotSchema.safeParse(value).success).toBe(false);
    });
    test("provider auto quality must reserve max without fabricating actual quality or fees", () => {
        const value = settings();
        value.effective.quality = "auto";
        expect(settingsSnapshotSchema.safeParse(value).success).toBe(false);
        value.estimate.reservationQuality = "max";
        expect(settingsSnapshotSchema.parse(value).actual).toBeNull();
        expect(settingsSnapshotSchema.parse(value).estimate.providerActualRmb).toBeNull();
    });
    test("validates each nested settings object strictly", () => {
        for (const field of ["sourceMap", "requested", "intent", "effective", "estimate"] as const) {
            const value = settings();
            expect(
                settingsSnapshotSchema.safeParse({ ...value, [field]: { ...value[field], apiKey: "injected" } })
                    .success,
            ).toBe(false);
        }
        const value = settings();
        value.effective.background = "transparent";
        value.effective.output_format = "jpeg";
        expect(settingsSnapshotSchema.safeParse(value).success).toBe(false);
        expect(
            settingsSnapshotSchema.safeParse({
                ...settings(),
                effective: { ...settings().effective, model: "another-model" },
            }).success,
        ).toBe(false);
        expect(
            settingsSnapshotSchema.safeParse({ ...settings(), effective: { ...settings().effective, n: 2 } }).success,
        ).toBe(false);
    });
    test("actual formats and costs are checked without rounding decimal receipts", () => {
        const actual = {
            quality: null,
            dimensions: { width: 123, height: 789 },
            outputFormat: "png" as const,
            mimeType: "image/png" as const,
            providerActualRmb: "0.12345678",
            usage: { totalTokens: 0 },
        };
        expect(generationActualSchema.parse(actual)).toEqual(actual);
        expect(generationActualSchema.safeParse({ ...actual, mimeType: "image/jpeg" }).success).toBe(false);
        expect(generationActualSchema.safeParse({ ...actual, quality: "auto" }).success).toBe(false);
        const value = settings();
        value.actual = actual;
        value.estimate.providerActualRmb = "0.12345677";
        expect(settingsSnapshotSchema.safeParse(value).success).toBe(false);
        value.estimate.providerActualRmb = "0.12345678";
        expect(settingsSnapshotSchema.safeParse(value).success).toBe(true);
        value.actual.providerActualRmb = "1.00";
        value.estimate.providerActualRmb = "1";
        expect(settingsSnapshotSchema.safeParse(value).success).toBe(true);
        value.actual.providerActualRmb = "9007199254740993.00000001";
        value.estimate.providerActualRmb = "9007199254740993.00000002";
        expect(settingsSnapshotSchema.safeParse(value).success).toBe(false);
    });
    test.each(["-1", "+1", "01", "1.", ".1", "1e2", "0.123456789", "NaN"])("rejects invalid money %s", (value) =>
        expect(decimalMoneySchema.safeParse(value).success).toBe(false));
});

describe("planner and durable context contract", () => {
    const plans: PlannerPlan[] = [
        { action: "discuss", assistantText: "可以保留当前设计。" },
        { action: "clarify", assistantText: "需要确认颜色。", question: "改哪个区域？", choices: ["衣领", "袖口"] },
        { action: "restore", assistantText: "返回原图。", target: { kind: "original" } },
        {
            action: "edit",
            assistantText: "在原图上保留当前设计并改色。",
            base: { kind: "original" },
            stateSource: "active",
            changes: [{ kind: "relative", target: "图案", instruction: "缩小 20%" }],
            preserve: ["人物身份"],
            revoke: ["background"],
            references: [{ versionId, role: "color", instruction: "沿用这个蓝色" }],
            outputIntent: { purpose: "detail", complexity: "low", explicitPreferences: { resolution: "4k" } },
        },
        {
            action: "generate_new",
            assistantText: "新建一张。",
            description: "蓝色外套",
            requestedState,
            references: [],
            outputIntent: { purpose: "standard", complexity: "medium", sizeMode: "provider_auto" },
        },
    ];
    test.each(plans)("accepts typed plan $action", (plan) => expect(plannerPlanSchema.parse(plan)).toEqual(plan));
    test("keeps every plan branch and nested selector strict", () => {
        for (const plan of plans)
            expect(plannerPlanSchema.safeParse({ ...plan, model: "injected" }).success).toBe(false);
        expect(plannerPlanSchema.safeParse({ ...plans[2], target: { kind: "current", versionId } }).success).toBe(
            false,
        );
        expect(plannerPlanSchema.safeParse({ ...plans[2], target: { kind: "version" } }).success).toBe(false);
        expect(plannerPlanSchema.safeParse({ ...plans[2], target: { kind: "version", versionId } }).success).toBe(true);
        expect(
            plannerPlanSchema.safeParse({
                ...plans[3],
                outputIntent: { purpose: "detail", complexity: "low", explicitPreferences: { mode: "auto" } },
            }).success,
        ).toBe(false);
        expect(
            plannerPlanSchema.safeParse({
                ...plans[3],
                changes: [{ kind: "relative", target: "图案", instruction: "缩小", applied: true }],
            }).success,
        ).toBe(false);
    });
    test("requested state only stores requirements, not observed pixel facts or replayable deltas", () => {
        expect(requestedStateSchema.parse(requestedState)).toEqual(requestedState);
        for (const source of ["vision_check", "assistant", "provider"])
            expect(
                requestedStateSchema.safeParse({
                    ...requestedState,
                    constraints: [{ ...requestedState.constraints[0], source }],
                }).success,
            ).toBe(false);
        expect(
            requestedStateSchema.safeParse({
                ...requestedState,
                changes: [{ kind: "relative", instruction: "缩小 20%" }],
            }).success,
        ).toBe(false);
        expect(requestedStateSchema.safeParse({ ...requestedState, observation: "已经呈现蓝色" }).success).toBe(false);
    });
    test("manifest requires explicit image preview and attachment-to-version registration", () => {
        const manifest: ContextManifest = {
            schemaVersion: 1,
            summaryThroughSeq: 0,
            messageSeqs: [1, 2],
            inputActiveVersionId: versionId,
            baseVersionId: versionId,
            sourceStateVersionId: versionId,
            images: [{ versionId, assetId, role: "base", previewed: false }],
            attachments: [{ assetId, versionId, purpose: "new_base" }],
            omittedHistory: false,
            policyVersion: "v1",
        };
        expect(contextManifestSchema.parse(manifest)).toEqual(manifest);
        expect(
            contextManifestSchema.safeParse({ ...manifest, images: [{ versionId, assetId, role: "base" }] }).success,
        ).toBe(false);
        expect(
            contextManifestSchema.safeParse({ ...manifest, attachments: [{ assetId, purpose: "auto" }] }).success,
        ).toBe(false);
        expect(
            contextManifestSchema.safeParse({
                ...manifest,
                attachments: [
                    manifest.attachments[0],
                    { assetId: modelConfigId, versionId: turnId, purpose: "new_base" },
                ],
            }).success,
        ).toBe(false);
        expect(
            contextManifestSchema.safeParse({
                ...manifest,
                attachments: [manifest.attachments[0], { assetId, versionId, purpose: "reference" }],
            }).success,
        ).toBe(false);
        expect(
            contextManifestSchema.safeParse({
                ...manifest,
                images: [{ ...manifest.images[0], url: "https://signed.example/image" }],
            }).success,
        ).toBe(false);
        expect(contextManifestSchema.safeParse({ ...manifest, messageSeqs: [0] }).success).toBe(false);
    });
    test("trusted model bindings preserve both roles and planner capability gates", () => {
        const binding: ModelRoleBindings = {
            planner: {
                displayName: "GPT-6.2 Sol",
                modelConfigId,
                provider: "configured-channel",
                apiModelId: "verified-api-id",
                requiredCapabilities: { vision: true, structuredOutput: true },
            },
            imageEdit: { modelConfigId, provider: "apimart", apiModelId: "gpt-image-2.6-flare" },
        };
        expect(modelRoleBindingsSchema.parse(binding)).toEqual(binding);
        expect(
            modelRoleBindingsSchema.safeParse({
                ...binding,
                planner: { ...binding.planner, requiredCapabilities: { vision: false, structuredOutput: true } },
            }).success,
        ).toBe(false);
    });
});

describe("public results and persisted events", () => {
    test("upload sources need not meet generation pixel limits, but must remain roots", () => {
        expect(imageVersionSchema.parse(uploadVersion())).toEqual(uploadVersion());
        for (const extra of [{ turnId }, { parameters: settings() }, { versionNo: 2 }, { rootVersionId: turnId }])
            expect(imageVersionSchema.safeParse({ ...uploadVersion(), ...extra }).success).toBe(false);
        const generated = { ...uploadVersion(), source: "generated", turnId, parameters: settings() };
        expect(imageVersionSchema.safeParse(generated).success).toBe(true);
        expect(imageVersionSchema.safeParse({ ...generated, turnId: null }).success).toBe(false);
    });
    test("detached turns cannot adopt results and discussion cannot have paid image tasks", () => {
        expect(imageTurnSchema.parse(turn())).toEqual(turn());
        expect(imageTurnSchema.safeParse({ ...turn(), state: "detached" }).success).toBe(false);
        expect(imageTurnSchema.safeParse({ ...turn(), state: "detached", autoActivate: false }).success).toBe(true);
        for (const intent of ["discuss", "clarify", "restore"])
            expect(imageTurnSchema.safeParse({ ...turn(), intent, taskId: assetId }).success).toBe(false);
        for (const code of ["PLANNER_OUTCOME_UNKNOWN", "UPSTREAM_OUTCOME_UNKNOWN"]) {
            expect(turnErrorSchema.safeParse({ code, message: "未知结果", retryable: true }).success).toBe(false);
            expect(turnErrorSchema.safeParse({ code, message: "未知结果", retryable: false }).success).toBe(true);
        }
    });
    test("messages reference versions and cannot be empty", () => {
        const message: ConversationMessage = {
            id: assetId,
            conversationId,
            turnId,
            seq: 1,
            role: "user",
            kind: "text",
            text: "修改",
            attachments: [],
            createdAt: now,
        };
        expect(conversationMessageSchema.parse(message)).toEqual(message);
        for (const extra of [
            { turnId: null },
            { kind: "image" },
            { text: null },
            { attachments: ["https://untrusted.example/image"] },
        ])
            expect(conversationMessageSchema.safeParse({ ...message, ...extra }).success).toBe(false);
    });
    test("SSE events use positive sequences, strict payloads and enumerated event kinds", () => {
        const base = { conversationId, seq: 1, turnId, createdAt: now };
        const events: ConversationEvent[] = [
            ...(
                [
                    "turn.accepted",
                    "turn.updated",
                    "plan.ready",
                    "task.queued",
                    "turn.completed",
                    "turn.failed",
                    "turn.cancelled",
                    "turn.detached",
                    "turn.uncertain",
                ] as const
            ).map((type) => ({ ...base, type, payload: { stateRevision: 1, turn: turn() } })),
            {
                ...base,
                type: "task.progress",
                payload: { stateRevision: 1, turnId, taskId: assetId, phase: "saving", progress: null },
            },
            { ...base, type: "version.created", payload: { stateRevision: 1, version: uploadVersion() } },
            {
                ...base,
                type: "active.changed",
                payload: { stateRevision: 1, activeVersionId: versionId, reason: "restore" },
            },
            {
                ...base,
                type: "context_summary.updated",
                payload: {
                    stateRevision: 1,
                    contextSummary: { schemaVersion: 1, text: "", goals: [], unresolvedQuestions: [] },
                    contextSummaryThroughSeq: 0,
                },
            },
            { ...base, type: "settings.resolved", payload: { stateRevision: 1, turnId, settingsSnapshot: settings() } },
        ];
        for (const event of events) {
            expect(conversationEventSchema.parse(event)).toEqual(event);
            expect(conversationEventSchema.safeParse({ ...event, seq: 0 }).success).toBe(false);
            expect(
                conversationEventSchema.safeParse({ ...event, payload: { ...event.payload, apiKey: "injected" } })
                    .success,
            ).toBe(false);
        }
        expect(conversationEventSchema.safeParse({ ...base, type: "unknown", payload: {} }).success).toBe(false);
        expect(
            conversationEventSchema.safeParse({
                ...base,
                type: "task.progress",
                payload: { stateRevision: 1, turnId, taskId: assetId, phase: "generating", progress: 101 },
            }).success,
        ).toBe(false);
    });
    test("snapshots do not expose detached turns as pending", () => {
        const snapshot = {
            id: conversationId,
            title: null,
            entrypoint: "standalone",
            projectUuid: null,
            canvasExternalId: null,
            activeVersionId: versionId,
            stateRevision: 1,
            createdAt: now,
            updatedAt: now,
            activeVersion: uploadVersion(),
            pendingTurn: turn(),
            latestEventSeq: 1,
            contextSummary: { schemaVersion: 1, text: "", goals: [], unresolvedQuestions: [] },
            contextSummaryThroughSeq: 0,
        };
        expect(conversationSnapshotSchema.safeParse(snapshot).success).toBe(true);
        expect(
            conversationSnapshotSchema.safeParse({
                ...snapshot,
                pendingTurn: { ...turn(), state: "detached", autoActivate: false },
            }).success,
        ).toBe(false);
    });
});
