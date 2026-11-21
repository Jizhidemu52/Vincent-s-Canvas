import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ContextManifest, PlannerPlan, SettingsSnapshot } from "../../../shared/image-conversation-contracts";
import {
    createImageConversation,
    submitImageConversationTurn,
    cancelImageConversationTurn,
    getImageConversation,
} from "../../src/image-conversation-service";
import {
    processImageConversationTurn,
    recoverExpiredConversationPlanning,
    type ImageConversationWorkerDependencies,
} from "../../src/image-conversation-worker";
import { ImageConversationPlannerError } from "../../src/image-conversation-planner";
import { classifyImageConversationError } from "../../src/image-conversation-runtime";
import { prepareTaskEnqueue } from "../../src/tasks";
import {
    createConversationPostgres as createIsolatedPostgres,
    conversationDatabaseMode,
} from "../helpers/conversation-postgres";

const integration = conversationDatabaseMode() ? describe : describe.skip;
const discussion: PlannerPlan = { action: "discuss", assistantText: "酒红色可以作为配色方向，先不生成。" };
const generation: PlannerPlan = {
    action: "generate_new",
    assistantText: "生成一张款式图。",
    description: "一件纯色针织衫",
    requestedState: { schemaVersion: 1, goals: ["纯色针织衫"], constraints: [] },
    references: [],
    outputIntent: { purpose: "standard", complexity: "medium" },
};
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

integration("durable conversation planner and atomic image admission", () => {
    let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
    const modelId = randomUUID();
    beforeAll(async () => {
        fixture = await createIsolatedPostgres({ planner: true });
        const providerId = randomUUID();
        await fixture.db.query(
            "INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Conversation worker fixture','custom','https://no-network.invalid')",
            [providerId],
        );
        await fixture.db.query(
            "INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,$2,'Conversation worker fixture','gpt-image-2.6-flare',ARRAY['generate','edit'],0,0)",
            [modelId, providerId],
        );
    }, 30_000);
    afterAll(async () => {
        await fixture?.close();
    });
    const row = async (sql: string, values: unknown[] = []) => (await fixture.db.query(sql, values)).rows[0];
    async function context(manualBase = false) {
        const ownerId = randomUUID();
        await fixture.db.query("INSERT INTO users(id,username,display_name) VALUES($1,$2,'Worker fixture')", [
            ownerId,
            `worker-${ownerId}`,
        ]);
        const assetId = manualBase ? randomUUID() : null;
        if (assetId)
            await fixture.db.query(
                "INSERT INTO assets(id,owner_user_id,object_key,filename,mime_type,byte_size,kind,status) VALUES($1,$2,$3,'manual-base.png','image/png',1,'image','ready')",
                [assetId, ownerId, `fixture/${assetId}`],
            );
        const conversation = (
            await createImageConversation(fixture.db, ownerId, {
                clientRequestId: randomUUID(),
                entrypoint: "standalone",
                ...(assetId ? { initialAssetId: assetId } : {}),
            })
        ).snapshot;
        const accepted = await submitImageConversationTurn(fixture.db, ownerId, conversation.id, {
            clientRequestId: randomUUID(),
            expectedStateRevision: conversation.stateRevision,
            text: "帮我看看配色",
            ...(assetId ? { attachments: [{ assetId, purpose: "new_base" }] } : {}),
        });
        return {
            ownerId,
            conversationId: conversation.id,
            turnId: accepted.result.turnId,
            assetId,
            versionId: conversation.activeVersionId,
        };
    }
    const manifest: ContextManifest = {
        schemaVersion: 1,
        summaryThroughSeq: 0,
        messageSeqs: [1],
        inputActiveVersionId: null,
        baseVersionId: null,
        sourceStateVersionId: null,
        images: [],
        attachments: [],
        omittedHistory: false,
        policyVersion: "test-v1",
    };
    const settings = (): SettingsSnapshot => ({
        policyVersion: "flare-auto-v1",
        requested: { mode: "auto" },
        intent: { purpose: "standard", complexity: "medium", sizeMode: "provider_auto" },
        effective: {
            modelConfigId: modelId,
            model: "gpt-image-2.6-flare",
            n: 1,
            quality: "high",
            resolution: "2k",
            size: "auto",
            complexity: "medium",
            output_format: "png",
        },
        resolutionApplied: true,
        sourceMap: {
            model: "admin_binding",
            n: "policy",
            quality: "policy",
            resolution: "policy",
            complexity: "policy",
            output_format: "policy",
            size: "policy",
        },
        estimate: {
            internalCredits: 0,
            internalRmb: "0",
            providerEstimatedRmb: null,
            providerActualRmb: null,
            priceSource: "fixture",
            priceVersion: "1",
            reservationQuality: "high",
        },
        actual: null,
    });
    function dependencies(plan: PlannerPlan = discussion) {
        const counts = { prepared: 0, dispatched: 0, images: 0, published: 0, wakes: 0 };
        const value: ImageConversationWorkerDependencies = {
            preparePlanner: async () => {
                counts.prepared++;
                return {
                    manifest,
                    run: async () => {
                        counts.dispatched++;
                        return plan;
                    },
                };
            },
            prepareImage: async (execution) => {
                counts.images++;
                return {
                    manifest,
                    settings: settings(),
                    validate: async () => {},
                    task: await prepareTaskEnqueue(fixture.db, {
                        requestId: `ic:${execution.turn.id}:image:1`,
                        userId: execution.conversation.owner_user_id,
                        departmentId: null,
                        projectId: "",
                        operationType: "image_generation",
                        toolKey: "image",
                        modelConfigId: modelId,
                        prompt: "Fixture only",
                        sourceUrls: [],
                        parameters: { n: 1 },
                        priority: "normal",
                        creditsEnabled: false,
                    }),
                };
            },
            resolveRestore: async () => {
                throw new Error("Unexpected restore");
            },
            publishTask: async () => {
                counts.published++;
            },
            wake: () => {
                counts.wakes++;
            },
        };
        return { value, counts };
    }
    test("two workers claim one turn, persist dispatch before one model call and complete a discussion without any image", async () => {
        const current = await context(),
            hooks = dependencies();
        hooks.value.preparePlanner = async () => ({
            manifest,
            run: async () => {
                hooks.counts.dispatched++;
                expect(
                    await row("SELECT planner_status,planner_request_id FROM image_conversation_turns WHERE id=$1", [
                        current.turnId,
                    ]),
                ).toEqual({ planner_status: "in_flight", planner_request_id: `ic:${current.turnId}:planner:1` });
                return discussion;
            },
        });
        const results = await Promise.all([
            processImageConversationTurn(fixture.db, current.turnId, hooks.value),
            processImageConversationTurn(fixture.db, current.turnId, hooks.value),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(hooks.counts.dispatched).toBe(1);
        expect(hooks.counts.images).toBe(0);
        expect(
            await row("SELECT state,planner_status,task_id FROM image_conversation_turns WHERE id=$1", [
                current.turnId,
            ]),
        ).toEqual({ state: "completed", planner_status: "succeeded", task_id: null });
        expect(
            (await getImageConversation(fixture.db, current.ownerId, current.conversationId)).pendingTurn,
        ).toBeNull();
        expect(
            (
                await row(
                    "SELECT count(*)::int n FROM image_conversation_messages WHERE turn_id=$1 AND role='assistant'",
                    [current.turnId],
                )
            ).n,
        ).toBe(1);
    });
    test.each<PlannerPlan>([
        discussion,
        { action: "clarify", assistantText: "先确认修改范围。", question: "只改配色吗？" },
    ])("manual base $action remains text-only and never admits an image task", async (plan) => {
        const current = await context(true),
            hooks = dependencies(plan);
        const selected: ContextManifest = {
            ...manifest,
            inputActiveVersionId: current.versionId,
            baseVersionId: current.versionId,
            sourceStateVersionId: current.versionId,
            images: [{ assetId: current.assetId!, versionId: current.versionId!, role: "current", previewed: true }],
            attachments: [{ assetId: current.assetId!, versionId: current.versionId!, purpose: "new_base" }],
        };
        hooks.value.preparePlanner = async () => ({ manifest: selected, run: async () => plan });
        expect(await processImageConversationTurn(fixture.db, current.turnId, hooks.value)).toBe(true);
        expect(
            await row("SELECT state,intent,task_id FROM image_conversation_turns WHERE id=$1", [current.turnId]),
        ).toEqual({ state: "completed", intent: plan.action, task_id: null });
        expect(hooks.counts.images).toBe(0);
        expect(hooks.counts.published).toBe(0);
        expect(await row("SELECT count(*)::int n FROM tasks WHERE user_id=$1", [current.ownerId])).toEqual({ n: 0 });
        expect((await getImageConversation(fixture.db, current.ownerId, current.conversationId)).activeVersionId).toBe(
            current.versionId,
        );
    });
    test("stopping in-flight planning fences a late successful reply and never enqueues an image", async () => {
        const current = await context(),
            hooks = dependencies(generation),
            called = deferred<void>(),
            reply = deferred<PlannerPlan>();
        hooks.value.preparePlanner = async () => ({
            manifest,
            run: () => {
                called.resolve();
                return reply.promise;
            },
        });
        const run = processImageConversationTurn(fixture.db, current.turnId, hooks.value);
        await called.promise;
        await cancelImageConversationTurn(fixture.db, current.ownerId, current.conversationId, current.turnId, {
            expectedStateRevision: 1,
        });
        reply.resolve(generation);
        expect(await run).toBe(false);
        expect(hooks.counts.images).toBe(0);
        expect(
            await row("SELECT state,plan,task_id,auto_activate FROM image_conversation_turns WHERE id=$1", [
                current.turnId,
            ]),
        ).toEqual({ state: "cancelled", plan: null, task_id: null, auto_activate: false });
    });

    test("history lookup manifests are persisted before another call and a cancelled fence rejects later updates", async () => {
        const current = await context(),
            hooks = dependencies();
        const next = { ...manifest, policyVersion: "history-lookup-fixture" };
        hooks.value.preparePlanner = async (_execution, updateManifest) => ({
            manifest,
            run: async () => {
                await updateManifest(next);
                expect(
                    (await row("SELECT context_manifest FROM image_conversation_turns WHERE id=$1", [current.turnId]))
                        .context_manifest,
                ).toEqual(next);
                await cancelImageConversationTurn(fixture.db, current.ownerId, current.conversationId, current.turnId, {
                    expectedStateRevision: 1,
                });
                let rejected = false;
                try {
                    await updateManifest({ ...next, policyVersion: "must-not-write" });
                } catch {
                    rejected = true;
                }
                expect(rejected).toBe(true);
                return discussion;
            },
        });
        expect(await processImageConversationTurn(fixture.db, current.turnId, hooks.value)).toBe(false);
        expect(
            (await row("SELECT context_manifest FROM image_conversation_turns WHERE id=$1", [current.turnId]))
                .context_manifest,
        ).toEqual(next);
        expect(hooks.counts.images).toBe(0);
    });
    test("expired dispatched lease ends unknown, permits a new independent turn and rejects the original late reply", async () => {
        const current = await context(),
            hooks = dependencies(generation),
            called = deferred<void>(),
            reply = deferred<PlannerPlan>();
        hooks.value.preparePlanner = async () => ({
            manifest,
            run: () => {
                hooks.counts.dispatched++;
                called.resolve();
                return reply.promise;
            },
        });
        const run = processImageConversationTurn(fixture.db, current.turnId, hooks.value);
        await called.promise;
        await fixture.db.query(
            "UPDATE image_conversation_turns SET planner_lease_expires_at=now()-interval '1 second' WHERE id=$1",
            [current.turnId],
        );
        expect(await recoverExpiredConversationPlanning(fixture.db, hooks.value.wake)).toBe(1);
        expect(
            await row(
                "SELECT state,planner_status,last_error->>'code' code FROM image_conversation_turns WHERE id=$1",
                [current.turnId],
            ),
        ).toEqual({ state: "failed", planner_status: "unknown", code: "PLANNER_OUTCOME_UNKNOWN" });
        const next = await submitImageConversationTurn(fixture.db, current.ownerId, current.conversationId, {
            clientRequestId: randomUUID(),
            expectedStateRevision: 1,
            text: "新的独立问题",
        });
        expect(next.result.state).toBe("accepted");
        reply.resolve(generation);
        expect(await run).toBe(false);
        expect(await processImageConversationTurn(fixture.db, current.turnId, hooks.value)).toBe(false);
        expect(hooks.counts.dispatched).toBe(1);
        expect(hooks.counts.images).toBe(0);
    });
    test("pre-dispatch failure is failed, whereas an unconfirmed dispatched call is unknown and never auto-retried", async () => {
        for (const dispatched of [false, true]) {
            const current = await context(),
                hooks = dependencies();
            hooks.value.preparePlanner = async () => {
                if (!dispatched) throw new Error("fixture preflight");
                return {
                    manifest,
                    run: async () => {
                        hooks.counts.dispatched++;
                        throw new Error("fixture transport lost");
                    },
                };
            };
            expect(await processImageConversationTurn(fixture.db, current.turnId, hooks.value)).toBe(false);
            expect(await processImageConversationTurn(fixture.db, current.turnId, hooks.value)).toBe(false);
            expect(
                await row(
                    "SELECT state,planner_status,last_error->>'code' code FROM image_conversation_turns WHERE id=$1",
                    [current.turnId],
                ),
            ).toEqual({
                state: "failed",
                planner_status: dispatched ? "unknown" : "failed",
                code: dispatched ? "PLANNER_OUTCOME_UNKNOWN" : "PLANNER_FAILED",
            });
            expect(hooks.counts.dispatched).toBe(dispatched ? 1 : 0);
        }
    });
    test.each([
        "not_submitted",
        "rejected",
        "unknown",
    ] as const)("classified %s planner errors retain dispatch evidence and never retry during recovery", async (outcome) => {
        const current = await context(),
            hooks = dependencies();
        hooks.value.classifyError = classifyImageConversationError;
        hooks.value.preparePlanner = async () => {
            hooks.counts.prepared++;
            return {
                manifest,
                run: async () => {
                    hooks.counts.dispatched++;
                    throw new ImageConversationPlannerError(
                        outcome === "not_submitted" ? "PLANNER_BINDING_CHANGED" : "PLANNER_PLAN_INVALID",
                        "已停止本轮规划",
                        outcome,
                    );
                },
            };
        };
        expect(await processImageConversationTurn(fixture.db, current.turnId, hooks.value)).toBe(false);
        expect(
            await row(
                "SELECT state,planner_status,last_error->>'code' code,(last_error->>'retryable')::boolean retryable,task_id FROM image_conversation_turns WHERE id=$1",
                [current.turnId],
            ),
        ).toEqual({
            state: "failed",
            planner_status: outcome === "unknown" ? "unknown" : "failed",
            code: outcome === "unknown" ? "PLANNER_OUTCOME_UNKNOWN" : "PLANNER_FAILED",
            retryable: false,
            task_id: null,
        });
        expect(await recoverExpiredConversationPlanning(fixture.db, hooks.value.wake)).toBe(0);
        expect(await processImageConversationTurn(fixture.db, current.turnId, hooks.value)).toBe(false);
        expect(hooks.counts.prepared).toBe(1);
        expect(hooks.counts.dispatched).toBe(1);
        expect(hooks.counts.images).toBe(0);
        expect(
            (
                await row(
                    "SELECT count(*)::int n FROM image_conversation_events WHERE turn_id=$1 AND event_type='turn.failed'",
                    [current.turnId],
                )
            ).n,
        ).toBe(1);
        expect(
            (
                await row(
                    "SELECT count(*)::int n FROM image_conversation_messages WHERE turn_id=$1 AND role='assistant'",
                    [current.turnId],
                )
            ).n,
        ).toBe(1);
    });
    test("received but malformed plan is a confirmed failure, not an uncertain provider submission", async () => {
        const current = await context(),
            hooks = dependencies();
        hooks.value.classifyError = classifyImageConversationError;
        hooks.value.preparePlanner = async () => ({
            manifest,
            run: async () => {
                hooks.counts.dispatched++;
                return { action: "unsupported" } as unknown as PlannerPlan;
            },
        });
        expect(await processImageConversationTurn(fixture.db, current.turnId, hooks.value)).toBe(false);
        expect(
            await row(
                "SELECT state,planner_status,last_error->>'code' code FROM image_conversation_turns WHERE id=$1",
                [current.turnId],
            ),
        ).toEqual({ state: "failed", planner_status: "failed", code: "PLANNER_FAILED" });
        expect(await recoverExpiredConversationPlanning(fixture.db, hooks.value.wake)).toBe(0);
        expect(hooks.counts.dispatched).toBe(1);
        expect(hooks.counts.images).toBe(0);
    });
    test("an accepted turn carrying an old dispatch marker fails unknown without preparing another planner", async () => {
        const current = await context(),
            hooks = dependencies();
        hooks.value.classifyError = classifyImageConversationError;
        await fixture.db.query(
            "UPDATE image_conversation_turns SET planner_dispatch_started_at=now(),planner_request_id=$2,planner_status='in_flight' WHERE id=$1",
            [current.turnId, `ic:${current.turnId}:planner:1`],
        );
        expect(await processImageConversationTurn(fixture.db, current.turnId, hooks.value)).toBe(false);
        expect(
            await row(
                "SELECT state,planner_status,last_error->>'code' code FROM image_conversation_turns WHERE id=$1",
                [current.turnId],
            ),
        ).toEqual({ state: "failed", planner_status: "unknown", code: "PLANNER_OUTCOME_UNKNOWN" });
        expect(await recoverExpiredConversationPlanning(fixture.db, hooks.value.wake)).toBe(0);
        expect(hooks.counts.prepared).toBe(0);
        expect(hooks.counts.dispatched).toBe(0);
        expect(hooks.counts.images).toBe(0);
    });
    test("persisted plan recovery never repeats the planner and creates one durable task despite Redis publication failure", async () => {
        const current = await context(),
            hooks = dependencies(generation);
        await fixture.db.query(
            `UPDATE image_conversation_turns SET state='planning',plan=$2,intent='generate_new',planner_status='succeeded',
      context_manifest=$3,planner_request_id=$4,planner_dispatch_started_at=now(),planner_lease_token=$5,planner_lease_expires_at=now()-interval '1 second' WHERE id=$1`,
            [
                current.turnId,
                JSON.stringify(generation),
                JSON.stringify(manifest),
                `ic:${current.turnId}:planner:1`,
                randomUUID(),
            ],
        );
        expect(await recoverExpiredConversationPlanning(fixture.db, hooks.value.wake)).toBe(1);
        hooks.value.publishTask = async () => {
            hooks.counts.published++;
            throw new Error("fixture Redis unavailable");
        };
        expect(await processImageConversationTurn(fixture.db, current.turnId, hooks.value)).toBe(true);
        expect(await processImageConversationTurn(fixture.db, current.turnId, hooks.value)).toBe(false);
        expect(hooks.counts.prepared).toBe(0);
        expect(hooks.counts.dispatched).toBe(0);
        expect(hooks.counts.images).toBe(1);
        expect(hooks.counts.published).toBe(1);
        const turn = await row(
            "SELECT state,task_id,task_request_id,settings_snapshot FROM image_conversation_turns WHERE id=$1",
            [current.turnId],
        );
        expect(turn.state).toBe("queued");
        expect(turn.task_request_id).toBe(`ic:${current.turnId}:image:1`);
        expect(turn.settings_snapshot).toEqual(settings());
        expect((await row("SELECT count(*)::int n FROM tasks WHERE request_id=$1", [turn.task_request_id])).n).toBe(1);
        expect(
            (
                await row(
                    "SELECT count(*)::int n FROM image_conversation_events WHERE turn_id=$1 AND event_type='task.queued'",
                    [current.turnId],
                )
            ).n,
        ).toBe(1);
    });
    test("cancellation during image preflight discards prepared task without task or fee writes", async () => {
        const current = await context(),
            hooks = dependencies(generation),
            ready = deferred<void>(),
            resume = deferred<void>();
        const prepare = hooks.value.prepareImage;
        hooks.value.prepareImage = async (execution) => {
            const image = await prepare(execution);
            ready.resolve();
            await resume.promise;
            return image;
        };
        const run = processImageConversationTurn(fixture.db, current.turnId, hooks.value);
        await ready.promise;
        await cancelImageConversationTurn(fixture.db, current.ownerId, current.conversationId, current.turnId, {
            expectedStateRevision: 1,
        });
        resume.resolve();
        await run;
        expect(
            (await row("SELECT count(*)::int n FROM tasks WHERE request_id=$1", [`ic:${current.turnId}:image:1`])).n,
        ).toBe(0);
        expect(
            (
                await row("SELECT count(*)::int n FROM credit_reservations WHERE request_id=$1", [
                    `ic:${current.turnId}:image:1`,
                ])
            ).n,
        ).toBe(0);
        expect(hooks.counts.published).toBe(0);
    });
    test("failure while persisting task event rolls back task, binding and fee together", async () => {
        const current = await context(),
            hooks = dependencies(generation);
        let injected = false;
        const db = new Proxy(fixture.db, {
            get(target, property) {
                if (property !== "connect") return Reflect.get(target, property);
                return async () => {
                    const client = await target.connect();
                    return new Proxy(client, {
                        get(connection, key) {
                            if (key !== "query") return Reflect.get(connection, key);
                            return async (sql: string, values?: unknown[]) => {
                                const result = await connection.query(sql, values);
                                if (
                                    !injected &&
                                    sql.startsWith("INSERT INTO image_conversation_events") &&
                                    values?.[3] === "task.queued"
                                ) {
                                    injected = true;
                                    throw new Error("fixture atomic rollback");
                                }
                                return result;
                            };
                        },
                    });
                };
            },
        });
        expect(await processImageConversationTurn(db, current.turnId, hooks.value)).toBe(false);
        expect(injected).toBe(true);
        expect(
            (await row("SELECT count(*)::int n FROM tasks WHERE request_id=$1", [`ic:${current.turnId}:image:1`])).n,
        ).toBe(0);
        expect(
            await row("SELECT state,task_id,settings_snapshot FROM image_conversation_turns WHERE id=$1", [
                current.turnId,
            ]),
        ).toEqual({ state: "failed", task_id: null, settings_snapshot: null });
        expect(hooks.counts.published).toBe(0);
    });
});
