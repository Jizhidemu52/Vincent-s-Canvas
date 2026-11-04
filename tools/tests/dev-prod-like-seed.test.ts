import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Database } from "../../server/src/db";
import { verifyPassword } from "../../server/src/security";
import { createIsolatedPostgres } from "../../server/tests/helpers/isolated-postgres";
import { createProdLikeConfig } from "../dev-prod-like.mjs";
import { seedProdLike } from "../dev-prod-like-seed";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const providerId = "0dc95b00-0000-4000-8000-000000000001";
const modelId = "0dc95b00-0000-4000-8000-000000000002";
const tools = ["image", "image-edit", "canvas-image", "canvas-edit", "canvas-mask-edit", "canvas-batch"];
const env = createProdLikeConfig([], {}).appEnv;

async function snapshot(db: Database) {
    return Promise.all(["users", "providers", "model_configs", "tool_api_configurations"].map(table =>
        db.query(`SELECT row_to_json(row) AS value FROM ${table} row ORDER BY row_to_json(row)::text`).then(result => result.rows)));
}

sqlTest("prod-like seed fills untouched migration bindings and repeating it preserves every seeded row", async () => {
    const state = await createIsolatedPostgres();
    let poolEnds = 0;
    const databaseFactory = () => ({ ...state.db, end: async () => { poolEnds++; } }) as Database;
    try {
        const initial = await state.db.query("SELECT tool_key,model_config_id,configuration_version FROM tool_api_configurations WHERE tool_key=ANY($1)", [tools]);
        expect(initial.rows).toHaveLength(6);
        expect(initial.rows.every(row => row.model_config_id === null && row.configuration_version === 1)).toBe(true);
        await seedProdLike(env, databaseFactory);
        const bindings = await state.db.query("SELECT model_config_id,configuration_version,enabled FROM tool_api_configurations WHERE tool_key=ANY($1)", [tools]);
        expect(bindings.rows.every(row => row.model_config_id === modelId && row.configuration_version === 2 && row.enabled)).toBe(true);
        const providers = await state.db.query("SELECT base_url,encrypted_credentials FROM providers WHERE id=$1", [providerId]);
        expect(providers.rows).toEqual([{ base_url: "http://127.0.0.1:9", encrypted_credentials: null }]);
        const user = (await state.db.query("SELECT password_hash,role,must_change_password FROM users WHERE username='prodlike-designer'")).rows[0];
        expect(user).toMatchObject({ role: "designer", must_change_password: true });
        expect(await verifyPassword(user.password_hash, "Prodlike-Designer-Only-2026!")).toBe(true);
        const before = await snapshot(state.db);
        await seedProdLike(env, databaseFactory);
        expect(await snapshot(state.db)).toEqual(before);
        expect(poolEnds).toBe(2);
    } finally { await state.close(); }
}, 60_000);

sqlTest("prod-like seed preserves existing passwords, disabled tools and manually maintained or cleared bindings", async () => {
    const state = await createIsolatedPostgres();
    const databaseFactory = () => ({ ...state.db, end: async () => {} }) as Database;
    try {
        await seedProdLike(env, databaseFactory);
        const userId = (await state.db.query("SELECT id FROM users WHERE username='prodlike-designer'")).rows[0].id;
        const otherModelId = randomUUID();
        await state.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,$2,'User choice','user-model',ARRAY['generate'],7,0.25)", [otherModelId, providerId]);
        await state.db.query("UPDATE users SET password_hash='user-password-sentinel',display_name='User changed',must_change_password=false,credit_balance=42 WHERE id=$1", [userId]);
        await state.db.query("UPDATE providers SET enabled=false,name='User provider' WHERE id=$1", [providerId]);
        await state.db.query("UPDATE model_configs SET enabled=false,name='User model' WHERE id=$1", [modelId]);
        await state.db.query("UPDATE tool_api_configurations SET model_config_id=$1 WHERE tool_key='image'", [otherModelId]);
        await state.db.query("UPDATE tool_api_configurations SET model_config_id=NULL,configuration_version=7 WHERE tool_key='image-edit'");
        await state.db.query("UPDATE tool_api_configurations SET model_config_id=NULL,configuration_version=1,updated_by=$1 WHERE tool_key='canvas-edit'", [userId]);
        await state.db.query("UPDATE tool_api_configurations SET enabled=false WHERE tool_key='canvas-mask-edit'");
        const before = await snapshot(state.db);
        await seedProdLike(env, databaseFactory);
        expect(await snapshot(state.db)).toEqual(before);
    } finally { await state.close(); }
}, 60_000);
