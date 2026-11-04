import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import type { UsageV2ReportResult } from "../../../shared/usage-report-v2";
import type { AppConfig } from "../../src/config";
import type { ChatCompletionInput, ChatCompletionResult } from "../../src/routes/chat";
import { createAdminUsageRouter, USAGE_ANALYSIS_SYSTEM } from "../../src/routes/usage-analytics";
import { encryptSecret } from "../../src/security";
import { processUsageRollups, queueUsageRollup } from "../../src/usage-rollups";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlSuite = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
type Preview = UsageV2ReportResult & {
    source: "v2";
    previewId: string;
    previewHash: string;
    expiresAt: string;
    includesPromptSamples: false;
    sampleCount: 0;
    systemPrompt: string;
    systemPromptVersion: string;
};
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const previewHash = (preview: Preview) =>
    sha256(
        JSON.stringify({
            source: "v2",
            systemPromptVersion: preview.systemPromptVersion,
            systemPrompt: preview.systemPrompt,
            content: preview.content,
        }),
    );

sqlSuite("V2 paid analysis frozen-preview HTTP/SQL boundaries", () => {
    let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
    let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
    let base: string;
    const actor = randomUUID(),
        otherAdmin = randomUUID(),
        person = randomUUID(),
        outsider = randomUUID();
    const department = randomUUID(),
        provider = randomUUID(),
        model = randomUUID();
    const encryptionKey = Buffer.alloc(32, 7).toString("base64");
    const modelCalls: ChatCompletionInput[] = [];
    let complete: (input: ChatCompletionInput) => Promise<ChatCompletionResult>;
    const filters = {
        from: "2026-10-01T00:00:00+08:00",
        to: "2026-10-02T00:00:00+08:00",
        compare: "none",
        departmentBasis: "at_event",
        userIds: [person],
        departmentIds: [department],
        boardKeys: ["image"],
        modelConfigIds: [model],
        operationTypes: ["image_generation"],
        search: "Alice",
    };
    const body = (page = "overview") => ({ page, period: "selected", filters });
    const send = (path: string, value: unknown, identity = "admin") =>
        fetch(`${base}/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-fixture-identity": identity },
            body: JSON.stringify(value),
        });
    const confirm = (preview: Pick<Preview, "previewId" | "previewHash">, extra: Record<string, unknown> = {}) => ({
        previewId: preview.previewId,
        previewHash: preview.previewHash,
        modelConfigId: model,
        confirm: true,
        source: "v2",
        ...extra,
    });
    const saved = async (id: string) =>
        (await fixture.db.query("SELECT * FROM usage_analysis_previews WHERE id=$1", [id])).rows[0]!;
    const preview = async (page = "overview"): Promise<Preview> => {
        const response = await send("analysis-preview-v2", body(page));
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        return (await response.json()).data as Preview;
    };

    beforeAll(async () => {
        fixture = await createIsolatedPostgres({ usageRollupsEnabled: true });
        const db = fixture.db;
        await db.query("INSERT INTO departments(id,name,code) VALUES($1,'PRIVATE_DEPARTMENT','paid-preview-fixture')", [
            department,
        ]);
        for (const [id, name, role] of [
            [actor, "paid-preview-admin", "super_admin"],
            [otherAdmin, "paid-preview-other", "super_admin"],
            [person, "paid-preview-person", "designer"],
            [outsider, "paid-preview-outsider", "designer"],
        ])
            await db.query(
                "INSERT INTO users(id,username,display_name,role,department_id,must_change_password) VALUES($1,$2,'PRIVATE_NAME Alice',$3,$4,false)",
                [id, name, role, department],
            );
        await db.query(
            "INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'PRIVATE_PROVIDER','openai','https://never-called.invalid',$2)",
            [provider, encryptSecret(JSON.stringify({ apiKey: "synthetic-never-send-key" }), encryptionKey)],
        );
        await db.query(
            "INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,rmb_cost) VALUES($1,$2,'PRIVATE_MODEL','synthetic-analysis',ARRAY['chat','generate'],0)",
            [model, provider],
        );
        for (const [userId, cost] of [
            [person, "0.234567"],
            [outsider, "9.000000"],
        ]) {
            const task = randomUUID();
            await db.query(
                "INSERT INTO tasks(id,request_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,tool_key,status,result_urls,queued_at,started_at,completed_at) VALUES($1,$1::uuid::text,$2,$3,'fixture','image_generation',$4,'PRIVATE_PROMPT','{}','image','success','[\"https://private.invalid/PRIVATE_IMAGE.png\"]','2026-10-01T01:00:00Z','2026-10-01T01:00:01Z','2026-10-01T01:00:02Z')",
                [task, userId, department, model],
            );
            await db.query(
                "INSERT INTO generation_history(task_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,credits,rmb_cost,status) SELECT id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,0,$2,'success' FROM tasks WHERE id=$1",
                [task, cost],
            );
        }
        await queueUsageRollup(db, { fromDay: "2026-10-01", toDay: "2026-10-01", idempotencyKey: randomUUID() }, actor);
        expect((await processUsageRollups(db, 1))[0]!.status).toBe("processed");
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            const identity = request.header("x-fixture-identity");
            if (identity !== "anonymous")
                Object.assign(request, {
                    auth: {
                        id: identity === "other-admin" ? otherAdmin : identity === "designer" ? person : actor,
                        role:
                            identity === "designer"
                                ? "designer"
                                : identity === "department-admin"
                                  ? "department_admin"
                                  : "super_admin",
                    },
                    ...(identity === "trial" ? { allowsAnonymousCreation: true } : {}),
                });
            next();
        });
        app.use(
            "/api/admin/usage",
            createAdminUsageRouter(db, { PROVIDER_ENCRYPTION_KEY: encryptionKey } as AppConfig, {
                complete: async (_model, _credentials, input) => {
                    modelCalls.push(structuredClone(input));
                    return complete(input);
                },
            }),
        );
        server = app.listen(0, "127.0.0.1");
        await new Promise<void>((resolve) => server!.once("listening", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing fixture port");
        base = `http://127.0.0.1:${address.port}/api/admin/usage`;
    }, 120000);
    beforeEach(() => {
        modelCalls.length = 0;
        complete = async () => ({
            content: "Synthetic analysis result: only observed aggregate evidence.",
            toolCalls: [],
        });
    });
    afterAll(async () => {
        if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server!.close(() => resolve()));
        }
        if (fixture) await fixture.close();
    });

    test("all six pages freeze anonymous report facts plus the exact system prompt for fifteen minutes without a provider call", async () => {
        const factsBefore = (await fixture.db.query("SELECT payload FROM usage_daily_facts ORDER BY payload->>'id'"))
            .rows;
        for (const page of ["overview", "people", "boards", "models", "quality", "flows"]) {
            const started = Date.now(),
                value = await preview(page),
                ended = Date.now();
            const free = await send("report-v2", body(page));
            expect(free.status).toBe(200);
            const report = (await free.json()).data as UsageV2ReportResult;
            expect(value).toMatchObject({
                source: "v2",
                page,
                period: "selected",
                includesPromptSamples: false,
                sampleCount: 0,
                systemPromptVersion: "usage-ai-v2.1",
            });
            expect(value.previewId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
            expect(value.previewHash).toBe(previewHash(value));
            expect(value.previewHash).not.toBe(sha256(value.content));
            expect(Date.parse(value.expiresAt)).toBeGreaterThanOrEqual(started + 15 * 60_000);
            expect(Date.parse(value.expiresAt)).toBeLessThanOrEqual(ended + 15 * 60_000);
            expect(value.content).toBe(report.content);
            expect(value.scope).toEqual(report.scope);
            expect(value.comparisonScope).toEqual(report.comparisonScope);
            const stored = await saved(value.previewId);
            expect(stored).toMatchObject({
                actor_user_id: actor,
                content: value.content,
                content_hash: value.previewHash,
                includes_prompt_samples: false,
                sample_count: 0,
                status: "preview",
                consumed_at: null,
            });
            expect(stored.filters).toMatchObject({
                source: "v2",
                page,
                period: "selected",
                systemPrompt: value.systemPrompt,
                systemPromptVersion: value.systemPromptVersion,
                scope: value.scope,
            });
            for (const text of [JSON.stringify(value), JSON.stringify(stored.filters)])
                for (const privateValue of [
                    "PRIVATE_",
                    "private.invalid",
                    "Alice",
                    actor,
                    person,
                    outsider,
                    department,
                    model,
                ])
                    expect(text).not.toContain(privateValue);
            if (["overview", "people", "quality"].includes(page))
                expect(JSON.parse(value.content).metrics.generationBookedCny.amount).toBe("0.234567");
            const audits = (
                await fixture.db.query("SELECT detail FROM audit_logs WHERE detail->>'previewId'=$1", [value.previewId])
            ).rows;
            expect(audits.length).toBeGreaterThan(0);
            expect(JSON.stringify(audits)).not.toContain("Alice");
            expect(JSON.stringify(audits)).not.toContain(person);
        }
        expect((await fixture.db.query("SELECT payload FROM usage_daily_facts ORDER BY payload->>'id'")).rows).toEqual(
            factsBefore,
        );
        expect(modelCalls).toHaveLength(0);
        expect((await fixture.db.query("SELECT count(*)::int AS n FROM credit_ledger")).rows[0].n).toBe(0);
    });

    test("unauthorized preview and confirmation requests never read facts, freeze a token or contact a provider", async () => {
        for (const identity of ["anonymous", "designer", "department-admin", "trial"]) {
            for (const [path, value] of [
                ["analysis-preview-v2", body()],
                ["analyze", confirm({ previewId: randomUUID(), previewHash: "a".repeat(64) })],
            ] as const) {
                const before = fixture.statements.length;
                const response = await send(path, value, identity);
                expect(response.status).toBe(403);
                expect(response.headers.get("cache-control")).toBe("no-store");
                expect(fixture.statements.length).toBe(before);
            }
        }
        expect(modelCalls).toHaveLength(0);
    });

    test("actor, hash, source and expiration mismatches reject without consuming a still-valid preview", async () => {
        const value = await preview();
        for (const [payload, identity] of [
            [confirm(value), "other-admin"],
            [confirm(value, { previewHash: "a".repeat(64) }), "admin"],
            [confirm(value, { source: "v1" }), "admin"],
            [confirm(value, { source: undefined }), "admin"],
        ] as const) {
            const response = await send("analyze", payload, identity);
            expect(response.status).toBe(409);
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(await saved(value.previewId)).toMatchObject({ status: "preview", consumed_at: null });
        }
        const expired = await preview();
        await fixture.db.query("UPDATE usage_analysis_previews SET expires_at=now()-interval '1 second' WHERE id=$1", [
            expired.previewId,
        ]);
        expect((await send("analyze", confirm(expired))).status).toBe(409);
        expect(await saved(expired.previewId)).toMatchObject({ status: "preview", consumed_at: null });
        expect(modelCalls).toHaveLength(0);
        expect((await send("analyze", confirm(value))).status).toBe(200);
        expect(modelCalls).toHaveLength(1);
    });

    test("confirmation rejects client content, system text, actor overrides and missing explicit confirmation before any database work", async () => {
        const value = await preview();
        for (const extra of [
            { content: "PRIVATE_INJECTION" },
            { systemPrompt: "PRIVATE_INJECTION" },
            { actorUserId: otherAdmin },
            { filters: { source: "v1" } },
            { confirm: false },
            { source: "v3" },
        ]) {
            const before = fixture.statements.length;
            const response = await send("analyze", confirm(value, extra));
            expect(response.status).toBe(400);
            expect(await response.text()).not.toContain("PRIVATE_INJECTION");
            expect(fixture.statements.length).toBe(before);
        }
        expect(await saved(value.previewId)).toMatchObject({ status: "preview", consumed_at: null });
        expect(modelCalls).toHaveLength(0);
    });

    test("two overlapping confirmations atomically claim once and send exactly the previewed content and system prompt", async () => {
        const value = await preview();
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        complete = async () => {
            entered();
            await gate;
            return { content: "Synthetic concurrent confirmation completed.", toolCalls: [] };
        };
        const first = send("analyze", confirm(value));
        try {
            await Promise.race([
                started,
                first.then((response) => {
                    throw new Error(`first confirmation returned ${response.status} before provider boundary`);
                }),
            ]);
            expect(await saved(value.previewId)).toMatchObject({ status: "processing", model_config_id: model });
            expect((await saved(value.previewId)).consumed_at).not.toBeNull();
            const second = await send("analyze", confirm(value));
            expect(second.status).toBe(409);
            expect(modelCalls).toHaveLength(1);
            expect(modelCalls[0]).toMatchObject({
                input: [
                    { role: "system", content: value.systemPrompt },
                    { role: "user", content: value.content },
                ],
                tools: [],
                webSearch: false,
            });
        } finally {
            release();
        }
        const response = await first;
        expect(response.status).toBe(200);
        expect((await response.json()).data).toMatchObject({
            source: "v2",
            analysisId: value.previewId,
            modelConfigId: model,
            content: "Synthetic concurrent confirmation completed.",
        });
        expect(await saved(value.previewId)).toMatchObject({
            status: "success",
            result: "Synthetic concurrent confirmation completed.",
        });
        expect((await send("analyze", confirm(value))).status).toBe(409);
        expect(modelCalls).toHaveLength(1);
    });

    test("provider failure leaves a consumed failed token and a second confirmation cannot charge again", async () => {
        const value = await preview();
        complete = async () => {
            throw new Error("PRIVATE_PROVIDER_FAILURE synthetic-never-send-key");
        };
        const failed = await send("analyze", confirm(value));
        expect(failed.status).toBe(502);
        expect(await failed.text()).not.toContain("PRIVATE_PROVIDER_FAILURE");
        expect(await saved(value.previewId)).toMatchObject({ status: "failed" });
        expect((await saved(value.previewId)).consumed_at).not.toBeNull();
        expect((await send("analyze", confirm(value))).status).toBe(409);
        expect(modelCalls).toHaveLength(1);
    });

    test("tampering with frozen content, system text or system version is rejected before the provider and cannot be replayed", async () => {
        for (const target of ["content", "systemPrompt", "systemPromptVersion"]) {
            const value = await preview();
            if (target === "content")
                await fixture.db.query("UPDATE usage_analysis_previews SET content=content||$2 WHERE id=$1", [
                    value.previewId,
                    "PRIVATE_TAMPER",
                ]);
            else
                await fixture.db.query(
                    "UPDATE usage_analysis_previews SET filters=jsonb_set(filters,ARRAY[$2]::text[],to_jsonb($3::text)) WHERE id=$1",
                    [value.previewId, target, "PRIVATE_TAMPER"],
                );
            const result = await send("analyze", confirm(value));
            expect(result.status).toBeGreaterThanOrEqual(400);
            expect(result.status).toBeLessThan(500);
            expect(await result.text()).not.toContain("PRIVATE_TAMPER");
            expect(await saved(value.previewId)).toMatchObject({ status: "failed" });
            expect((await saved(value.previewId)).consumed_at).not.toBeNull();
            expect((await send("analyze", confirm(value))).status).toBe(409);
        }
        expect(modelCalls).toHaveLength(0);
    });

    test("a modified stored hash cannot bypass either the presented hash check or the frozen V2 prompt-content binding", async () => {
        const value = await preview();
        const contentOnlyHash = sha256(value.content);
        await fixture.db.query("UPDATE usage_analysis_previews SET content_hash=$2 WHERE id=$1", [
            value.previewId,
            contentOnlyHash,
        ]);
        expect((await send("analyze", confirm(value))).status).toBe(409);
        expect(await saved(value.previewId)).toMatchObject({ status: "preview", consumed_at: null });
        const forged = await send("analyze", confirm(value, { previewHash: contentOnlyHash }));
        expect(forged.status).toBeGreaterThanOrEqual(400);
        expect(forged.status).toBeLessThan(500);
        expect(await saved(value.previewId)).toMatchObject({ status: "failed" });
        expect(modelCalls).toHaveLength(0);
    });

    test("a valid earlier-version frozen prompt is sent verbatim instead of being replaced by today's system constant", async () => {
        const value = await preview();
        // Model an unexpired preview issued before a prompt-version deployment.
        const earlier = {
            ...value,
            systemPromptVersion: "usage-ai-v2.0",
            systemPrompt:
                "Frozen earlier-version synthetic instruction: use aggregate evidence only; never assess personnel performance.",
        };
        earlier.previewHash = previewHash(earlier);
        await fixture.db.query(
            "UPDATE usage_analysis_previews SET filters=filters||$2::jsonb,content_hash=$3 WHERE id=$1",
            [
                earlier.previewId,
                JSON.stringify({
                    systemPrompt: earlier.systemPrompt,
                    systemPromptVersion: earlier.systemPromptVersion,
                }),
                earlier.previewHash,
            ],
        );
        const response = await send("analyze", confirm(earlier));
        expect(response.status).toBe(200);
        expect(modelCalls).toHaveLength(1);
        expect(modelCalls[0]).toMatchObject({
            input: [
                { role: "system", content: earlier.systemPrompt },
                { role: "user", content: earlier.content },
            ],
        });
        expect(await saved(earlier.previewId)).toMatchObject({ status: "success" });
    });

    test("legacy preview and omitted-source confirmation remain V1, while V2 sends its separately frozen system prompt", async () => {
        const legacyResponse = await send("analysis-preview", {
            from: filters.from,
            to: filters.to,
            userIds: [person],
            boardKey: "image",
            includePromptSamples: false,
        });
        expect(legacyResponse.status).toBe(200);
        const legacy = (await legacyResponse.json()).data as Pick<Preview, "previewId" | "previewHash" | "content">;
        expect(legacy.previewHash).toBe(sha256(legacy.content));
        expect((await send("analyze", confirm(legacy))).status).toBe(409);
        expect(await saved(legacy.previewId)).toMatchObject({ status: "preview", consumed_at: null });
        const result = await send("analyze", confirm(legacy, { source: undefined }));
        expect(result.status).toBe(200);
        expect((await result.json()).data).toMatchObject({ analysisId: legacy.previewId, modelConfigId: model });
        expect(modelCalls[0]).toMatchObject({
            input: [
                { role: "system", content: USAGE_ANALYSIS_SYSTEM },
                { role: "user", content: legacy.content },
            ],
        });
        const value = await preview();
        expect(value.systemPrompt).not.toBe(USAGE_ANALYSIS_SYSTEM);
        expect((await send("analyze", confirm(value))).status).toBe(200);
        expect(modelCalls[1]).toMatchObject({
            input: [
                { role: "system", content: value.systemPrompt },
                { role: "user", content: value.content },
            ],
        });
        expect(modelCalls).toHaveLength(2);
    });
});
