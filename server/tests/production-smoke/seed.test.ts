import { expect, test } from "bun:test";
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from "../../src/security";
import { isSelectableCreativeModel } from "../../src/model-presentation";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { assertSmokeSeedEnvironment, seedSmokeDatabase } from "./seed";
import { SMOKE_PROVIDER_KEY } from "./mock-provider";

const env = {
    CANVAS_SMOKE_PROJECT: "ci-release-123-1-amd64", CANVAS_SMOKE_ALLOW_SEED: "isolated-compose-only", CANVAS_SMOKE_SOURCE_ROOT: "/app/src",
    NODE_ENV: "production", TASK_MOCK_MODE: "false", AUTH_ENABLED: "true", OA_LOGIN_ENABLED: "false",
    DATABASE_URL: "postgres://wireless_canvas:synthetic-smoke-password@postgres:5432/wireless_canvas", REDIS_URL: "redis://redis:6379",
    S3_ENDPOINT: "http://minio:9000", S3_PUBLIC_ENDPOINT: "", S3_BUCKET: "canvas-ci", PROVIDER_ENCRYPTION_KEY: Buffer.alloc(32, 23).toString("base64"),
};
const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;

test("smoke seed rejects production hosts, Demo/mock tasks and incomplete isolation guards", () => {
    expect(assertSmokeSeedEnvironment(env)).toBe(env.CANVAS_SMOKE_PROJECT);
    for (const patch of [
        { CANVAS_SMOKE_PROJECT: "production" }, { CANVAS_SMOKE_ALLOW_SEED: "" }, { CANVAS_SMOKE_SOURCE_ROOT: "../../src" },
        { DATABASE_URL: env.DATABASE_URL.replace("@postgres:", "@production:") }, { DATABASE_URL: `${env.DATABASE_URL}?host=production` },
        { NODE_ENV: "development" }, { TASK_MOCK_MODE: "true" }, { AUTH_ENABLED: "false" }, { OA_LOGIN_ENABLED: "true" },
        { REDIS_URL: "redis://127.0.0.1:6379" }, { S3_ENDPOINT: "https://storage.example" }, { S3_BUCKET: "production" },
        { S3_PUBLIC_ENDPOINT: "https://production.example" }, { PROVIDER_ENCRYPTION_KEY: "invalid" },
    ]) expect(() => assertSmokeSeedEnvironment({ ...env, ...patch })).toThrow();
});

sqlTest("formal smoke seed creates usable local-provider bindings and rejects replay without changing rows", async () => {
    const state = await createIsolatedPostgres();
    try {
        const seed = await seedSmokeDatabase(state.db, env, { hashPassword, encryptSecret });
        expect(seed).toMatchObject({ project: env.CANVAS_SMOKE_PROJECT, paid: false, providerOrigin: "http://mock-provider:4180" });
        const user = (await state.db.query("SELECT password_hash,role,must_change_password,credit_balance FROM users WHERE id=$1", [seed.userId])).rows[0];
        expect(user).toMatchObject({ role: "designer", must_change_password: false, credit_balance: 1000 });
        expect(await verifyPassword(user.password_hash, seed.password)).toBe(true);
        const providers = await state.db.query("SELECT base_url,encrypted_credentials FROM providers");
        expect(providers.rows).toHaveLength(2);
        for (const provider of providers.rows) {
            expect(provider.base_url).toBe("http://mock-provider:4180/v1");
            expect(JSON.parse(decryptSecret(provider.encrypted_credentials, env.PROVIDER_ENCRYPTION_KEY))).toEqual({ apiKey: SMOKE_PROVIDER_KEY });
        }
        const models = await state.db.query(`SELECT m.id,m.model_id AS "modelId",m.capabilities,p.id AS "providerId",p.name AS "providerName",p.base_url AS "providerBaseUrl",p.protocol
            FROM model_configs m JOIN providers p ON p.id=m.provider_id`);
        expect(models.rows).toHaveLength(3);
        expect(models.rows.every(isSelectableCreativeModel)).toBe(true);
        const bindings = await state.db.query("SELECT tool_key,model_config_id,allow_raw_prompt FROM tool_api_configurations WHERE model_config_id IS NOT NULL");
        expect(bindings.rows).toHaveLength(10);
        expect(bindings.rows.find(row => row.tool_key === "canvas-image").model_config_id).toBe(seed.models.image);
        expect(bindings.rows.find(row => row.tool_key === "video")).toMatchObject({ model_config_id: seed.models.video, allow_raw_prompt: true });
        expect(bindings.rows.find(row => row.tool_key === "gpt-chat").model_config_id).toBe(seed.models.chat);
        const before = await state.db.query("SELECT row_to_json(u) AS value FROM users u");
        await expect(seedSmokeDatabase(state.db, env, { hashPassword, encryptSecret })).rejects.toThrow("empty disposable database");
        expect((await state.db.query("SELECT row_to_json(u) AS value FROM users u")).rows).toEqual(before.rows);
    } finally { await state.close(); }
}, 60_000);

sqlTest("smoke seed rolls back its new rows if migrated bindings were already maintained", async () => {
    const state = await createIsolatedPostgres();
    try {
        await state.db.query("UPDATE tool_api_configurations SET configuration_version=3 WHERE tool_key='canvas-image'");
        await expect(seedSmokeDatabase(state.db, env, { hashPassword, encryptSecret })).rejects.toThrow("preconfigured tool bindings");
        for (const table of ["users", "providers", "model_configs"]) expect((await state.db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0);
        expect((await state.db.query("SELECT configuration_version FROM tool_api_configurations WHERE tool_key='canvas-image'")).rows[0].configuration_version).toBe(3);
    } finally { await state.close(); }
}, 60_000);
