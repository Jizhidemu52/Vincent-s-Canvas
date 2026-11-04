import { createDatabase } from "../server/src/db";
import { hashPassword } from "../server/src/security";
import { assertProdLikeDatabase } from "./dev-prod-like.mjs";

const providerId = "0dc95b00-0000-4000-8000-000000000001";
const modelId = "0dc95b00-0000-4000-8000-000000000002";

export async function seedProdLike(env = process.env, databaseFactory = createDatabase) {
    assertProdLikeDatabase(env);
    const db = databaseFactory(env.DATABASE_URL!);
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query(`INSERT INTO users(username,display_name,password_hash,role,must_change_password,credit_balance,credit_limit)
            VALUES($1,$2,$3,'designer',true,1000,1000) ON CONFLICT(username) DO NOTHING`,
        ["prodlike-designer", "本地正式栈测试设计师", await hashPassword("Prodlike-Designer-Only-2026!")]);
        // No credentials and a loopback discard endpoint: this cannot contact a
        // real provider even if a developer manually disables Worker mock mode.
        await client.query(`INSERT INTO providers(id,name,protocol,base_url,enabled)
            VALUES($1,'Prod-like image mock (no provider key)','openai','http://127.0.0.1:9',true) ON CONFLICT(id) DO NOTHING`, [providerId]);
        await client.query(`INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost,concurrency_limit,enabled)
            VALUES($1,$2,'本地图片模拟（仅测试）','gpt-image-2',ARRAY['generate','edit','batch'],0,0,2,true) ON CONFLICT(id) DO NOTHING`, [modelId, providerId]);
        for (const tool of ["image", "image-edit", "canvas-image", "canvas-edit", "canvas-mask-edit", "canvas-batch"]) {
            await client.query(`INSERT INTO tool_api_configurations(tool_key,model_config_id,enabled)
                VALUES($1,$2,true) ON CONFLICT(tool_key) DO UPDATE SET model_config_id=EXCLUDED.model_config_id,
                    configuration_version=tool_api_configurations.configuration_version+1,updated_at=now()
                WHERE tool_api_configurations.model_config_id IS NULL AND tool_api_configurations.updated_by IS NULL
                    AND tool_api_configurations.configuration_version=1`, [tool, modelId]);
        }
        await client.query("COMMIT");
        console.log("Isolated prod-like test account/image model prepared; existing passwords, bindings and records were not overwritten.");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
        await db.end();
    }
}

if (import.meta.main) await seedProdLike();
