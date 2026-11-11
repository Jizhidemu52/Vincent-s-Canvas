import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { ApiMartImageQueryRetryable, ApiMartImageTaskPending, preflightApiMartImageRequest, stepApiMartImageTask, type ApiMartImageTaskInput } from "../src/apimart-image";
import { assertImageEditMaskSupport, prepareImageEditInput } from "../src/image-edit-input";
import { imageAgentProviderPrompt, type ImageAgentProfile } from "../src/image-agent-profile";
import { postgresPromptRecipeStore } from "../src/prompt-recipe-postgres";
import { createIsolatedPostgres } from "./helpers/isolated-postgres";
import type { AgentDocumentCatalogEntry, DesignRequirements } from "../../shared/image-agent-documents";
import { compileImageAgentPrompt } from "../../web/src/lib/image-agent/compile";

// The production entrypoint starts configured services. Extract only the same
// real functions used by the existing Worker tests, with no config/.env import.
const workerText = await Bun.file(new URL("../src/worker.ts", import.meta.url)).text();
const workerAst = ts.createSourceFile("worker.ts", workerText, ts.ScriptTarget.Latest, true);
const workerCode = ["executeProvider", "executeApiMartImage"].map(name => {
    const declaration = workerAst.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    if (!declaration) throw new Error(`Missing production function ${name}`);
    return ts.transpileModule(declaration.getText(workerAst), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}).join("\n");

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
const profiles: ImageAgentProfile[] = ["creative-chat", "canvas-assistant"];
const rules = (profile: ImageAgentProfile) => `PRIVATE_WORKER_FIXTURE_${profile}: Preserve the supplied structure and follow the user's current change.`;
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8////fwYGBgYWEAHCAD4KBAICIHhuAAAAAElFTkSuQmCC", "base64");
const sourceAsset = { bytes, mimeType: "image/png", filename: "original.png", assetId: randomUUID(), objectKey: "private/fixture/original.png", etag: '"fixture-original"' };
const sourceUrl = `/api/assets/${sourceAsset.assetId}/content`;
const ownedOrigin = "https://owned.example";
const ownedReferenceUrl = `${ownedOrigin}/api/provider-images/${"a".repeat(64)}/image`;
type GrantInput = { taskId: string; userId: string; executionToken: string; source: typeof sourceAsset };
const timing = { measure: async (_stage: string, operation: () => unknown) => operation() };
const documentCatalog: AgentDocumentCatalogEntry[] = [{ id: "brief", name: "需求.pdf", kind: "pdf", sectionCount: 1, figureCount: 1,
    sections: [{ id: "brief:page-1", figureIds: ["brief:figure-1"] }] }];
const designRequirements: DesignRequirements = { title: "开衫", documentIds: ["brief"], subject: "女士落肩开衫", colors: "浅燕麦色", materials: "羊毛混纺",
    must: ["保留五粒扣"], avoid: ["亮片"], unknowns: ["袖长尚未提供"], referenceFigureIds: ["brief:figure-1"], sources: [{ documentId: "brief", sectionId: "brief:page-1" }] };

integration("production Worker exact image-agent prompt boundary over isolated PostgreSQL", () => {
    let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
    let store: ReturnType<typeof postgresPromptRecipeStore>;
    const actor = randomUUID(), provider = randomUUID(), model = randomUUID();
    const activeVersions = new Map<ImageAgentProfile, string>();
    const guards: Array<{ mockRestore(): void }> = [];
    let unexpectedEgress = 0;
    const blocked = () => { unexpectedEgress++; throw new Error("WORKER_PROFILE_TEST_EXTERNAL_IO_BLOCKED"); };

    beforeAll(async () => {
        guards.push(spyOn(globalThis, "fetch").mockImplementation(Object.assign(blocked, { preconnect: blocked })));
        guards.push(spyOn(Bun, "spawn").mockImplementation(blocked));
        guards.push(spyOn(Bun, "spawnSync").mockImplementation(blocked));
        fixture = await createIsolatedPostgres();
        store = postgresPromptRecipeStore(fixture.db);
        await fixture.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,$2,'Worker profile fixture','designer')", [actor, `worker-profile-${actor}`]);
        await fixture.db.query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Worker profile fixture','apimart','https://provider.invalid/v1')", [provider]);
        await fixture.db.query("INSERT INTO model_configs(id,provider_id,name,model_id) VALUES($1,$2,'Worker profile fixture','gpt-image-2')", [model, provider]);
        for (const profile of profiles) {
            await store.ensure(profile, { name: profile, enabled: true, modelConfigId: null, failurePolicy: "stop" });
            const version = await store.saveVersion(profile, { systemPrompt: rules(profile), fieldTemplate: "", modelOverrides: {}, fallbackPrompt: "", outputLanguage: "zh", changeNote: "isolated fixture only" }, actor);
            await store.activate(profile, version.id);
            activeVersions.set(profile, version.id);
        }
    }, 45_000);

    afterAll(async () => {
        try { await fixture?.close(); }
        finally { for (const guard of guards.slice().reverse()) guard.mockRestore(); }
        expect(unexpectedEgress).toBe(0);
    });

    async function createTask(profile: ImageAgentProfile, edit = false, documentParameters: Record<string, unknown> = {}) {
        const id = randomUUID(), executionToken = randomUUID();
        const instruction = "只把衣服改成浅蓝色，版型和纽扣保持原样";
        const prompt = documentParameters.designRequirements ? compileImageAgentPrompt({ prompt: instruction, keep: [], images: [], requirements: documentParameters.designRequirements as DesignRequirements }).prompt : instruction;
        const parameters = { imageAgentProfile: profile, size: "3:4", inputArchive: { prompt, references: edit ? [{ id: "source", name: "original.png" }] : [] }, ...documentParameters };
        await fixture.db.query(`INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,status,execution_token,lease_expires_at)
            VALUES($1,$2,$3,'worker-profile-fixture',$4,$5,$6,$7,$8,'processing',$9,now()+interval '1 hour')`,
            [id, `request-${id}`, actor, edit ? "inpaint" : "image_generation", model, prompt, JSON.stringify(parameters), JSON.stringify(edit ? [sourceUrl] : []), executionToken]);
        return loadTask(id);
    }

    async function loadTask(id: string): Promise<Record<string, any>> {
        const row = (await fixture.db.query("SELECT * FROM tasks WHERE id=$1", [id])).rows[0]!;
        return { ...row, protocol: "apimart", base_url: "https://provider.invalid/v1", model_id: "gpt-image-2", encrypted_credentials: "fixture-encrypted-only" };
    }

    async function publicRecord(id: string) {
        return (await fixture.db.query("SELECT prompt,parameters,source_urls,user_input,prompt_optimized FROM tasks WHERE id=$1", [id])).rows[0];
    }

    function harness() {
        const requests: Array<{ method: string; url: string; prompt?: string; body?: Record<string, unknown> }> = [];
        const loadedSources: string[] = [];
        const grants: GrantInput[] = [];
        const cache = {}, storage = {};
        const fakeFetch = async (url: string, init?: RequestInit) => {
            expect(new URL(url).origin).toBe("https://provider.invalid");
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key-only");
            if (init?.method === "POST") {
                const body = JSON.parse(String(init.body));
                expect(new URL(url).pathname).toBe("/v1/images/generations");
                requests.push({ method: "POST", url, prompt: body.prompt, body });
                return Response.json({ data: [{ task_id: `fixture-upstream-${requests.length}` }] });
            }
            expect(init?.method).toBe("GET");
            expect(new URL(url).pathname).toMatch(/^\/v1\/tasks\/fixture-upstream-/);
            requests.push({ method: "GET", url });
            return Response.json({ data: { status: "completed", result: { images: [{ url: "https://provider.invalid/result.png" }] } } });
        };
        const dependencies = {
            db: fixture.db, postgresPromptRecipeStore, imageAgentProviderPrompt,
            config: { PROVIDER_ENCRYPTION_KEY: "fixture-encryption-only", PROVIDER_IMAGE_PUBLIC_ORIGIN: ownedOrigin },
            cache, storage,
            decryptSecret: (value: string) => { expect(value).toBe("fixture-encrypted-only"); return '{"apiKey":"fixture-key-only"}'; },
            assertImageEditMaskSupport, prepareImageEditInput, preflightApiMartImageRequest,
            ApiMartImageTaskPending, ApiMartImageQueryRetryable,
            VideoSubmissionClaimLost: class extends Error {},
            loadSourceAssets: async (urls: string[]) => {
                loadedSources.push(...urls);
                return urls.map(url => { expect(url).toBe(sourceUrl); return sourceAsset; });
            },
            // Grant storage/serving is tested separately; verify this real Worker
            // forwards its task/employee/lease and the original source unchanged.
            ProviderImageAccess: class {
                constructor(database: unknown, suppliedCache: unknown, suppliedStorage: unknown, origin: string) {
                    expect(database).toBe(fixture.db);
                    expect(suppliedCache).toBe(cache);
                    expect(suppliedStorage).toBe(storage);
                    expect(origin).toBe(ownedOrigin);
                }
                async issue(input: GrantInput) {
                    const task = (await fixture.db.query("SELECT user_id,execution_token,source_urls,upstream_submission_started_at FROM tasks WHERE id=$1", [input.taskId])).rows[0]!;
                    expect(input.userId).toBe(task.user_id);
                    expect(input.executionToken).toBe(task.execution_token);
                    expect(task.source_urls).toEqual([sourceUrl]);
                    expect(task.upstream_submission_started_at).toBeNull();
                    expect(input.source).toEqual(sourceAsset);
                    expect(input.source.bytes).toBe(bytes);
                    grants.push(input);
                    return ownedReferenceUrl;
                }
            },
            // Keep the real APIMart state machine; replace only its network runtime.
            stepApiMartImageTask: (input: ApiMartImageTaskInput) => stepApiMartImageTask(input, { fetch: fakeFetch, sleep: blocked }),
            fetchProviderResult: async (url: string) => { expect(url).toBe("https://provider.invalid/result.png"); return { bytes, mimeType: "image/png" }; },
            fetch: blocked, fetchProviderSubmission: blocked, executeWorkflow: blocked, executeApiMartVideo: blocked,
        };
        const execute = new Function(...Object.keys(dependencies), `${workerCode}\nreturn executeProvider;`)(...Object.values(dependencies)) as (task: Record<string, any>, timing: unknown) => Promise<unknown>;
        return { execute: (task: Record<string, any>) => execute(task, timing), requests, loadedSources, grants };
    }

    test.each(profiles)("%s sends exactly its public prompt and resumes the same task without reading recipes", async profile => {
        const task = await createTask(profile, profile === "creative-chat"), h = harness();
        const saved = await publicRecord(task.id), archive = structuredClone(task.parameters.inputArchive);
        await expect(h.execute(task)).rejects.toBeInstanceOf(ApiMartImageTaskPending);
        expect(h.requests).toHaveLength(1);
        const sent = h.requests[0]!;
        expect(sent.method).toBe("POST");
        expect(h.grants).toHaveLength(profile === "creative-chat" ? 1 : 0);
        expect(sent.body!.image_urls).toEqual(profile === "creative-chat" ? [ownedReferenceUrl] : undefined);
        expect(sent.prompt).toBe(task.prompt);
        expect(sent.prompt).not.toContain(rules(profile));
        expect(sent.prompt).not.toContain(rules(profiles.find(value => value !== profile)!));
        const nonPromptFields = Object.fromEntries(Object.entries(sent.body!).filter(([key]) => key !== "prompt"));
        expect(JSON.stringify(nonPromptFields)).not.toContain("PRIVATE_WORKER_FIXTURE");
        expect(task.prompt).toBe(saved!.prompt);
        expect(task.parameters.inputArchive).toEqual(archive);
        expect(await publicRecord(task.id)).toEqual(saved);
        const persisted = await loadTask(task.id);
        expect(persisted.upstream_task_id).toBe("fixture-upstream-1");
        expect(persisted.upstream_submission_started_at).not.toBeNull();
        const loadedBeforeResume = h.loadedSources.length;
        const grantsBeforeResume = h.grants.length;
        // A recipe can be disabled after submission. Polling must not reload it
        // or turn an already paid task into a new request.
        await fixture.db.query("UPDATE prompt_recipes SET current_version_id=NULL WHERE key=$1", [profile]);
        const statementStart = fixture.statements.length;
        try {
            const result = await h.execute(persisted) as Array<{ bytes: Uint8Array }>;
            expect(result).toHaveLength(1);
            expect(result[0]!.bytes).toEqual(bytes);
            expect(h.requests.map(request => request.method)).toEqual(["POST", "GET"]);
            expect(h.requests[1]!.url).toBe("https://provider.invalid/v1/tasks/fixture-upstream-1");
            expect(h.loadedSources).toHaveLength(loadedBeforeResume);
            expect(h.grants).toHaveLength(grantsBeforeResume);
            expect(fixture.statements.slice(statementStart).some(sql => /prompt_recipes|prompt_recipe_versions/.test(sql))).toBe(false);
            expect(await publicRecord(task.id)).toEqual(saved);
            expect(JSON.stringify(await publicRecord(task.id))).not.toContain("PRIVATE_WORKER_FIXTURE");
        } finally { await store.activate(profile, activeVersions.get(profile)!); }
    });

    test.each(profiles)("%s without an active recipe still sends the already prepared public prompt exactly once", async profile => {
        const task = await createTask(profile, true), h = harness(), saved = await publicRecord(task.id);
        await fixture.db.query("UPDATE prompt_recipes SET current_version_id=NULL WHERE key=$1", [profile]);
        try {
            const statementStart = fixture.statements.length;
            await expect(h.execute(task)).rejects.toBeInstanceOf(ApiMartImageTaskPending);
            expect(h.requests).toHaveLength(1);
            expect(h.requests[0]!.prompt).toBe(task.prompt);
            expect(h.loadedSources).toHaveLength(1);
            expect(h.grants).toHaveLength(1);
            expect(h.requests[0]!.body!.image_urls).toEqual([ownedReferenceUrl]);
            expect((await loadTask(task.id)).upstream_submission_started_at).not.toBeNull();
            expect((await loadTask(task.id)).upstream_task_id).toBe("fixture-upstream-1");
            expect(fixture.statements.slice(statementStart).some(sql => /prompt_recipes|prompt_recipe_versions/.test(sql))).toBe(false);
            expect(await publicRecord(task.id)).toEqual(saved);
        } finally { await store.activate(profile, activeVersions.get(profile)!); }
    });

    test("the actual public compiler preserves confirmed document requirements without hidden worker expansion", async () => {
        const task = await createTask("creative-chat", false, { designRequirements, designDocumentCatalog: documentCatalog }), h = harness();
        const saved = await publicRecord(task.id);
        await expect(h.execute(task)).rejects.toBeInstanceOf(ApiMartImageTaskPending);
        expect(h.requests).toHaveLength(1);
        expect(h.requests[0]!.prompt).toContain("女士落肩开衫");
        expect(h.requests[0]!.prompt).toContain("保留五粒扣");
        expect(h.requests[0]!.prompt).not.toContain("袖长尚未提供");
        expect(h.requests[0]!.prompt).not.toContain("brief:figure-1");
        expect(h.requests[0]!.prompt).toBe(task.prompt);
        expect(task.parameters.inputArchive.prompt).toBe(task.prompt);
        expect(h.loadedSources).toEqual([]);
        expect(h.grants).toEqual([]);
        expect(await publicRecord(task.id)).toEqual(saved);
    });

    test("mismatched or missing document manifests stop the real worker before recipe reads, asset reads or submission", async () => {
        for (const designDocumentCatalog of [undefined, [{ ...documentCatalog[0]!, sections: [{ id: "brief:page-1", figureIds: ["different:figure-1"] }] }]]) {
            const task = await createTask("canvas-assistant", true, { designRequirements, ...(designDocumentCatalog ? { designDocumentCatalog } : {}) }), h = harness();
            const saved = await publicRecord(task.id), statementStart = fixture.statements.length;
            await expect(h.execute(task)).rejects.toMatchObject({ code: "IMAGE_AGENT_REQUIREMENTS_INVALID" });
            expect(h.requests).toHaveLength(0);
            expect(h.loadedSources).toHaveLength(0);
            expect(h.grants).toHaveLength(0);
            expect(fixture.statements.slice(statementStart).some(sql => /prompt_recipes|prompt_recipe_versions/.test(sql))).toBe(false);
            expect((await loadTask(task.id)).upstream_submission_started_at).toBeNull();
            expect(await publicRecord(task.id)).toEqual(saved);
        }
    });

    test("submitted-without-id and changed synchronous/workflow routes never resubmit or load recipes", async () => {
        const task = await createTask("canvas-assistant", true), h = harness();
        await fixture.db.query("UPDATE tasks SET upstream_submission_started_at=now() WHERE id=$1", [task.id]);
        const submitted = await loadTask(task.id), saved = await publicRecord(task.id);
        await fixture.db.query("UPDATE prompt_recipes SET current_version_id=NULL WHERE key=$1", ["canvas-assistant"]);
        const statementStart = fixture.statements.length;
        try {
            await expect(h.execute(submitted)).rejects.toThrow("图片提交状态未知");
            await expect(h.execute({ ...submitted, protocol: "openai" })).rejects.toThrow("渠道配置已变更");
            await expect(h.execute({ ...submitted, upstream_task_id: "fixture-upstream-known", workflow_config_id: "changed-workflow" })).rejects.toThrow("渠道配置已变更");
            expect(h.requests).toHaveLength(0);
            expect(h.loadedSources).toHaveLength(0);
            expect(h.grants).toHaveLength(0);
            expect(fixture.statements.slice(statementStart).some(sql => /prompt_recipes|prompt_recipe_versions/.test(sql))).toBe(false);
            expect(await publicRecord(task.id)).toEqual(saved);
            expect((await loadTask(task.id)).upstream_submission_started_at).not.toBeNull();
        } finally { await store.activate("canvas-assistant", activeVersions.get("canvas-assistant")!); }
    });
});
