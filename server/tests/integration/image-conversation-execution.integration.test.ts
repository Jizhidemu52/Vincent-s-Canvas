import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { expectedRejection } from "../helpers/expected-rejection";
import { randomUUID } from "node:crypto";
import type {
    ContextManifest,
    EditPlan,
    GenerateNewPlan,
    OutputPreferences,
    PlannerPlan,
} from "../../../shared/image-conversation-contracts";
import { MARK_IMAGE_PROVIDER_ID } from "../../../shared/mark-image-models";
import { prepareConversationImage, resolveConversationRestore } from "../../src/image-conversation-execution";
import { createImageConversation, submitImageConversationTurn } from "../../src/image-conversation-service";
import { readConversation, type TurnRow } from "../../src/image-conversation-store";
import type { ConversationExecution } from "../../src/image-conversation-worker";
import { withTransaction } from "../../src/db-transaction";
import {
    createConversationPostgres as createIsolatedPostgres,
    conversationDatabaseMode,
} from "../helpers/conversation-postgres";

const integration = conversationDatabaseMode() ? describe : describe.skip;
const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAGklEQVR4nGP89eHZfzZBGYYof5eTyyrkfgAASSYH7r6GSqYAAAAASUVORK5CYII=",
    "base64",
);
const generate: GenerateNewPlan = {
    action: "generate_new",
    assistantText: "生成一件针织衫",
    description: "一件纯色针织衫",
    requestedState: { schemaVersion: 1, goals: ["纯色针织衫"], constraints: [] },
    references: [],
    outputIntent: { purpose: "standard", complexity: "medium" },
};
const edit: EditPlan = {
    action: "edit",
    assistantText: "只改颜色",
    base: { kind: "current" },
    stateSource: "base",
    changes: [{ kind: "set", target: "color", instruction: "衣服改成酒红色" }],
    preserve: ["针织纹理"],
    revoke: [],
    references: [],
    outputIntent: { purpose: "standard", complexity: "low" },
};

integration("conversation image execution uses frozen owned originals and configured Flare", () => {
    let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
    const modelId = randomUUID(),
        providerId = MARK_IMAGE_PROVIDER_ID;
    const options = { creditsEnabled: async () => false, readAsset: async () => bytes };
    beforeAll(async () => {
        fixture = await createIsolatedPostgres({ planner: true });
        await fixture.db.query(
            "INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Execution fixture','apimart','https://no-network.invalid')",
            [providerId],
        );
        await fixture.db.query(
            "INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,$2,'Execution Flare','gpt-image-2.6-flare',ARRAY['generate','edit'],0,0)",
            [modelId, providerId],
        );
        await fixture.db.query(
            "UPDATE tool_api_configurations SET model_config_id=$1,enabled=true,credit_cost_override=0,rmb_cost_override=0 WHERE tool_key='gpt-chat-image'",
            [modelId],
        );
    }, 30_000);
    afterAll(async () => {
        await fixture?.close();
    });
    const row = async (sql: string, values: unknown[] = []) => (await fixture.db.query(sql, values)).rows[0];
    async function stage(
        plan: PlannerPlan = generate,
        outputPreferences?: OutputPreferences,
        manualBase?: "current" | "other",
        imageModelConfigId?: string,
    ) {
        const ownerId = randomUUID();
        await fixture.db.query(
            "INSERT INTO users(id,username,display_name,must_change_password) VALUES($1,$2,'Execution fixture',false)",
            [ownerId, `execution-${ownerId}`],
        );
        const assetId = randomUUID();
        await fixture.db.query(
            "INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,status) VALUES($1,$2,$3,'source.png','image/png',$4,'image','ready')",
            [assetId, ownerId, `fixture/${assetId}`, bytes.byteLength],
        );
        const conversation = (
            await createImageConversation(fixture.db, ownerId, {
                clientRequestId: randomUUID(),
                entrypoint: "standalone",
                initialAssetId: assetId,
            })
        ).snapshot;
        const manualBaseAssetId = manualBase === "other" ? randomUUID() : manualBase === "current" ? assetId : null;
        if (manualBase === "other")
            await fixture.db.query(
                "INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,status) VALUES($1,$2,$3,'manual-base.png','image/png',$4,'image','ready')",
                [manualBaseAssetId, ownerId, `fixture/${manualBaseAssetId}`, bytes.byteLength],
            );
        const accepted = await submitImageConversationTurn(fixture.db, ownerId, conversation.id, {
            clientRequestId: randomUUID(),
            expectedStateRevision: conversation.stateRevision,
            text: "按本轮要求处理针织衫",
            ...(imageModelConfigId ? { imageModelConfigId } : {}),
            outputPreferences,
            ...(manualBaseAssetId ? { attachments: [{ assetId: manualBaseAssetId, purpose: "new_base" }] } : {}),
        });
        const manualBaseVersionId: string | null = manualBaseAssetId
            ? (
                  await row("SELECT id FROM image_conversation_versions WHERE conversation_id=$1 AND asset_id=$2", [
                      conversation.id,
                      manualBaseAssetId,
                  ])
              ).id
            : null;
        const manifest: ContextManifest = {
            schemaVersion: 1,
            summaryThroughSeq: 0,
            messageSeqs: [1],
            inputActiveVersionId: conversation.activeVersionId,
            baseVersionId: null,
            sourceStateVersionId: null,
            images: [{ versionId: conversation.activeVersionId!, assetId, role: "current", previewed: true }],
            attachments: [],
            omittedHistory: false,
            policyVersion: "test-context-v1",
        };
        if (manualBaseAssetId && manualBaseVersionId) {
            manifest.attachments = [
                { assetId: manualBaseAssetId, versionId: manualBaseVersionId, purpose: "new_base" },
            ];
            if (manualBase === "other")
                manifest.images.push({
                    assetId: manualBaseAssetId,
                    versionId: manualBaseVersionId,
                    role: "reference",
                    previewed: true,
                });
        }
        await fixture.db.query(
            "UPDATE image_conversation_turns SET plan=$2,intent=$3,planner_status='succeeded',context_manifest=$4 WHERE id=$1",
            [accepted.result.turnId, JSON.stringify(plan), plan.action, JSON.stringify(manifest)],
        );
        const execution: ConversationExecution = {
            conversation: await readConversation(fixture.db, ownerId, conversation.id),
            turn: (await row("SELECT * FROM image_conversation_turns WHERE id=$1", [
                accepted.result.turnId,
            ])) as TurnRow,
        };
        return {
            execution,
            ownerId,
            assetId,
            versionId: conversation.activeVersionId!,
            manualBaseAssetId,
            manualBaseVersionId,
        };
    }
    async function prepared(current: Awaited<ReturnType<typeof stage>>) {
        const result = await prepareConversationImage(fixture.db, current.execution, options);
        if ("clarification" in result) throw new Error(result.clarification.question);
        return result;
    }

    test("new image freezes the server binding and one-output pricing without inheriting an unrelated active image", async () => {
        const current = await stage(),
            result = await prepared(current);
        expect(result.task.input).toMatchObject({
            requestId: `ic:${current.execution.turn.id}:image:1`,
            operationType: "image_generation",
            modelConfigId: modelId,
            sourceUrls: [],
            priority: "normal",
            projectId: "",
        });
        expect(result.settings.effective).toMatchObject({
            model: "gpt-image-2.6-flare",
            modelConfigId: modelId,
            quality: "high",
            resolution: "2k",
            n: 1,
        });
        expect(result.manifest.baseVersionId).toBeNull();
        expect(await row("SELECT count(*)::int n FROM tasks WHERE user_id=$1", [current.ownerId])).toEqual({ n: 0 });
        await withTransaction(fixture.db, result.validate);
    });
    test("edit keeps original asset first, decodes real size and omits size rather than sending auto", async () => {
        const current = await stage(edit),
            result = await prepared(current);
        expect(result.task.input.sourceUrls).toEqual([`/api/assets/${current.assetId}/content`]);
        expect(result.task.input.operationType).toBe("inpaint");
        expect(result.task.input.parameters).not.toHaveProperty("size");
        expect(result.task.input.prompt).toContain("衣服改成酒红色");
        expect(result.task.input.prompt).toContain("针织纹理");
        expect(result.manifest).toMatchObject({
            baseVersionId: current.versionId,
            sourceStateVersionId: current.versionId,
        });
        await withTransaction(fixture.db, result.validate);
    });
    test("a persisted image plan cannot replace the manually selected base or bypass it as a new image", async () => {
        for (const plan of [edit, generate]) {
            const current = await stage(plan, undefined, "other");
            let assetReads = 0;
            expect(
                await expectedRejection(
                    prepareConversationImage(fixture.db, current.execution, {
                        ...options,
                        readAsset: async () => {
                            assetReads++;
                            return bytes;
                        },
                    }),
                ),
            ).toMatchObject({ code: "VALIDATION_ERROR" });
            expect(assetReads).toBe(0);
            expect(await row("SELECT count(*)::int n FROM tasks WHERE user_id=$1", [current.ownerId])).toEqual({
                n: 0,
            });
        }
    });
    test("matching manual selections keep the chosen current or other image first", async () => {
        for (const choice of ["current", "other"] as const) {
            const current = await stage(edit, undefined, choice);
            if (choice === "other")
                current.execution.turn.plan = {
                    ...edit,
                    base: { kind: "version", versionId: current.manualBaseVersionId! },
                };
            const result = await prepared(current);
            expect(result.task.input.sourceUrls).toEqual([`/api/assets/${current.manualBaseAssetId}/content`]);
            expect(result.manifest.baseVersionId).toBe(current.manualBaseVersionId);
            await withTransaction(fixture.db, result.validate);
        }
    });
    test("manual base metadata cannot be removed, assigned to another asset or introduced after acceptance", async () => {
        for (const defect of ["removed", "other_asset", "introduced"] as const) {
            const current = await stage(edit, undefined, "current");
            const manifest = current.execution.turn.context_manifest as ContextManifest;
            if (defect === "removed") manifest.attachments = [];
            if (defect === "other_asset") manifest.attachments[0]!.assetId = randomUUID();
            if (defect === "introduced") current.execution.turn.input_payload.attachments = [];
            expect(await expectedRejection(prepared(current))).toMatchObject({ code: "VALIDATION_ERROR" });
        }
    });
    test("restoration honors a manual selection without admitting a generation task", async () => {
        const current = await stage(
            { action: "restore", assistantText: "只恢复，不加工", target: { kind: "current" } },
            undefined,
            "other",
        );
        expect(
            await expectedRejection(resolveConversationRestore(fixture.db, current.execution, options)),
        ).toMatchObject({ code: "VALIDATION_ERROR" });
        if (!current.manualBaseVersionId) throw new Error("Expected a manually selected base version");
        current.execution.turn.plan = {
            action: "restore",
            assistantText: "只恢复所选图片，不加工",
            target: { kind: "version", versionId: current.manualBaseVersionId },
        };
        expect(await resolveConversationRestore(fixture.db, current.execution, options)).toBe(
            current.manualBaseVersionId,
        );
        expect(await row("SELECT count(*)::int n FROM tasks WHERE user_id=$1", [current.ownerId])).toEqual({ n: 0 });
    });
    test("restoring an existing version reads the original and never creates an image task", async () => {
        const current = await stage({ action: "restore", assistantText: "回到原图", target: { kind: "original" } });
        expect(await resolveConversationRestore(fixture.db, current.execution, options)).toBe(current.versionId);
        expect(await row("SELECT count(*)::int n FROM tasks WHERE user_id=$1", [current.ownerId])).toEqual({ n: 0 });
    });
    test("changed tool configuration or price is rejected at transaction validation", async () => {
        const current = await stage(),
            result = await prepared(current);
        await fixture.db.query(
            "UPDATE tool_api_configurations SET configuration_version=configuration_version+1 WHERE tool_key='gpt-chat-image'",
        );
        expect(await expectedRejection(withTransaction(fixture.db, result.validate))).toMatchObject({
            code: "MODEL_BINDING_UNAVAILABLE",
        });
        const next = await prepared(current);
        await fixture.db.query("UPDATE model_configs SET credit_cost=credit_cost+1 WHERE id=$1", [modelId]);
        expect(await expectedRejection(withTransaction(fixture.db, next.validate))).toMatchObject({
            code: "PRICE_UNAVAILABLE",
        });
        await fixture.db.query("UPDATE model_configs SET credit_cost=0 WHERE id=$1", [modelId]);
    });
    test("deleted or reassigned original cannot pass the post-preflight fence", async () => {
        const current = await stage(edit),
            result = await prepared(current);
        await fixture.db.query("UPDATE assets SET deleted_at=now() WHERE id=$1", [current.assetId]);
        expect(await expectedRejection(withTransaction(fixture.db, result.validate))).toMatchObject({
            code: "ASSET_NOT_READY",
        });
    });
    test("an explicit image choice freezes the chosen config and price on generation and editing", async () => {
        const selectedId = randomUUID();
        await fixture.db.query(
            "INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,$2,'Execution detail','gpt-image-2.6-sunburst',ARRAY['generate','edit'],2,0.01)",
            [selectedId, MARK_IMAGE_PROVIDER_ID],
        );
        for (const plan of [generate, edit]) {
            const result = await prepared(await stage(plan, undefined, undefined, selectedId));
            expect(result.task.input.modelConfigId).toBe(selectedId);
            expect(result.settings.sourceMap.model).toBe("explicit_user");
            expect(result.settings.effective).toMatchObject({ modelConfigId: selectedId, model: "gpt-image-2.6-sunburst" });
            expect(result.task.input.parameters?.conversationInput).toMatchObject({ modelConfigId: selectedId, modelIdentityHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
            await withTransaction(fixture.db, result.validate);
        }
    });
    test("wrong-model binding is not replaced by another catalog model", async () => {
        const current = await stage();
        await fixture.db.query("UPDATE model_configs SET model_id='mai-image-2.7-flash' WHERE id=$1", [modelId]);
        try {
            expect(await expectedRejection(prepared(current))).toMatchObject({ code: "MODEL_CAPABILITY_MISMATCH" });
        } finally {
            await fixture.db.query("UPDATE model_configs SET model_id='gpt-image-2.6-flare' WHERE id=$1", [modelId]);
        }
    });
    test("a matching Flare model on a different APIMart provider cannot replace the specified channel", async () => {
        const alternateProvider = randomUUID(),
            alternateModel = randomUUID(),
            current = await stage();
        await fixture.db.query(
            "INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Other APIMart channel','apimart','https://never-called.invalid')",
            [alternateProvider],
        );
        await fixture.db.query(
            "INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,$2,'Same Flare name','gpt-image-2.6-flare',ARRAY['generate','edit'],0,0)",
            [alternateModel, alternateProvider],
        );
        await fixture.db.query(
            "UPDATE tool_api_configurations SET model_config_id=$1 WHERE tool_key='gpt-chat-image'",
            [alternateModel],
        );
        try {
            expect(await expectedRejection(prepared(current))).toMatchObject({ code: "MODEL_CAPABILITY_MISMATCH" });
            expect(await row("SELECT count(*)::int n FROM tasks WHERE user_id=$1", [current.ownerId])).toEqual({
                n: 0,
            });
        } finally {
            await fixture.db.query(
                "UPDATE tool_api_configurations SET model_config_id=$1 WHERE tool_key='gpt-chat-image'",
                [modelId],
            );
        }
    });
    test("foreign version and corrupt original are rejected before admission", async () => {
        const foreign = await stage(),
            current = await stage({ ...edit, base: { kind: "version", versionId: foreign.versionId } });
        expect(await expectedRejection(prepared(current))).toMatchObject({ code: "NOT_FOUND" });
        const owned = await stage(edit);
        expect(
            await expectedRejection(
                prepareConversationImage(fixture.db, owned.execution, {
                    ...options,
                    readAsset: async () => new Uint8Array(bytes.length),
                }),
            ),
        ).toMatchObject({ code: "ASSET_NOT_READY" });
    });
    test("explicit parameter conflicts become clarification without an image task", async () => {
        const current = await stage(
            { ...generate, outputIntent: { ...generate.outputIntent, explicitPreferences: { resolution: "4k" } } },
            { mode: "manual", resolution: "1k" },
        );
        expect(await prepareConversationImage(fixture.db, current.execution, options)).toMatchObject({
            clarification: { action: "clarify" },
        });
        expect(await row("SELECT count(*)::int n FROM tasks WHERE user_id=$1", [current.ownerId])).toEqual({ n: 0 });
    });
    test("exact pixels remain exact and never carry a fictitious resolution", async () => {
        const current = await stage(generate, { mode: "manual", size: "1600x1200" }),
            result = await prepared(current);
        expect(result.task.input.parameters?.size).toBe("1600x1200");
        expect(result.task.input.parameters).not.toHaveProperty("resolution");
        expect(result.settings.resolutionApplied).toBe(false);
    });
    test("administrative quality and size limits block image admission without a silent downgrade", async () => {
        const current = await stage(generate, { mode: "manual", resolution: "4k" });
        expect(
            await expectedRejection(
                prepareConversationImage(fixture.db, current.execution, {
                    ...options,
                    outputLimits: { allowedResolutions: ["1k", "2k"] },
                }),
            ),
        ).toMatchObject({ code: "OUTPUT_SETTINGS_INVALID", reason: "RESOLUTION_NOT_ALLOWED" });
        expect(
            await expectedRejection(
                prepareConversationImage(fixture.db, current.execution, {
                    ...options,
                    outputLimits: { allowedQualities: ["low", "medium"] },
                }),
            ),
        ).toMatchObject({ code: "OUTPUT_SETTINGS_INVALID", reason: "QUALITY_NOT_ALLOWED" });
        expect(await row("SELECT count(*)::int n FROM tasks WHERE user_id=$1", [current.ownerId])).toEqual({ n: 0 });
        const allowed = await prepareConversationImage(fixture.db, current.execution, {
            ...options,
            outputLimits: { allowedQualities: ["high"], allowedResolutions: ["4k"], maxInternalCredits: 0 },
        });
        expect(allowed).toHaveProperty("settings.effective.resolution", "4k");
    });
});
