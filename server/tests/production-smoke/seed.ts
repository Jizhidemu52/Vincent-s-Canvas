import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "../../src/db";
import { SMOKE_PROVIDER_KEY } from "./mock-provider";
import { assertSmokeProject } from "./identity";

type SeedSecurity = {
    hashPassword(password: string): Promise<string>;
    encryptSecret(value: string, key: string): string;
};
type Environment = Record<string, string | undefined>;

/** A name alone is not authority: require the disposable Compose endpoints and modes too. */
export function assertSmokeSeedEnvironment(env: Environment) {
    const project = assertSmokeProject(env);
    if (env.CANVAS_SMOKE_ALLOW_SEED !== "isolated-compose-only"
        || env.CANVAS_SMOKE_SOURCE_ROOT !== "/app/src"
        || env.NODE_ENV !== "production" || env.TASK_MOCK_MODE !== "false"
        || env.AUTH_ENABLED !== "true" || env.OA_LOGIN_ENABLED !== "false"
        || env.REDIS_URL !== "redis://redis:6379"
        || env.S3_ENDPOINT !== "http://minio:9000" || env.S3_BUCKET !== "canvas-ci"
        || env.S3_PUBLIC_ENDPOINT) throw new Error("Smoke seed requires the explicit isolated CI formal stack");
    let database: URL;
    try { database = new URL(env.DATABASE_URL || ""); }
    catch { throw new Error("Invalid isolated smoke database address"); }
    if (database.protocol !== "postgres:" || database.hostname !== "postgres" || database.port !== "5432"
        || database.username !== "wireless_canvas" || database.pathname !== "/wireless_canvas"
        || database.password.length < 16 || database.search || database.hash
        || Buffer.from(env.PROVIDER_ENCRYPTION_KEY || "", "base64").length !== 32) {
        throw new Error("Smoke seed refuses non-isolated database or encryption configuration");
    }
    return project;
}

/** Real PostgreSQL rows only; no session injection, backend substitutes or production records. */
export async function seedSmokeDatabase(db: Database, env: Environment, security: SeedSecurity) {
    const project = assertSmokeSeedEnvironment(env);
    const identity = { userId: randomUUID(), username: `smoke-${project}`, password: `Smoke-9-${randomBytes(24).toString("base64url")}` };
    const providers = { imageChat: randomUUID(), video: randomUUID() };
    const models = { image: randomUUID(), video: randomUUID(), chat: randomUUID() };
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query("LOCK TABLE users,providers,model_configs,tasks,assets IN SHARE ROW EXCLUSIVE MODE");
        const existing = await client.query<{ count: number }>(`SELECT ((SELECT count(*) FROM users)+(SELECT count(*) FROM providers)
            +(SELECT count(*) FROM model_configs)+(SELECT count(*) FROM tasks)+(SELECT count(*) FROM assets))::int AS count`);
        if (existing.rows[0]?.count !== 0) throw new Error("Smoke seed requires an empty disposable database; existing records were not changed");
        await client.query(`INSERT INTO users(id,username,display_name,password_hash,role,status,must_change_password,credit_balance,credit_limit,monthly_credit_limit)
            VALUES($1,$2,'正式隔离栈验收账号',$3,'designer','active',false,1000,1000,1000)`,
        [identity.userId, identity.username, await security.hashPassword(identity.password)]);
        const encrypted = security.encryptSecret(JSON.stringify({ apiKey: SMOKE_PROVIDER_KEY }), env.PROVIDER_ENCRYPTION_KEY!);
        // OpenToken is the existing image/chat catalog identity. The endpoint is
        // always our internal test service, not the real provider named here.
        await client.query(`INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES
            ($1,'OpenToken','openai','http://mock-provider:4180/v1',$3),
            ($2,'Isolated smoke video','apimart','http://mock-provider:4180/v1',$3)`, [providers.imageChat, providers.video, encrypted]);
        await client.query(`INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost,concurrency_limit) VALUES
            ($1,$4,'Smoke image','gpt-image-2',ARRAY['generate','edit','batch'],1,0,2),
            ($2,$5,'Smoke video','MiniMax-H3',ARRAY['video'],1,0,2),
            ($3,$4,'Smoke chat','gpt-6-astra',ARRAY['chat'],1,0,2)`, [models.image, models.video, models.chat, providers.imageChat, providers.video]);
        for (const [keys, model] of [
            [["image", "image-edit", "canvas-image", "canvas-edit", "canvas-mask-edit", "canvas-batch"], models.image],
            [["video", "canvas-video"], models.video], [["gpt-chat", "canvas-chat"], models.chat],
        ] as const) {
            const result = await client.query(`UPDATE tool_api_configurations SET model_config_id=$1,enabled=true,
                credit_cost_override=1,rmb_cost_override=0,configuration_version=configuration_version+1,
                allow_raw_prompt=tool_key IN ('video','canvas-video'),updated_by=$3,updated_at=now()
                WHERE tool_key=ANY($2::text[]) AND model_config_id IS NULL AND updated_by IS NULL AND configuration_version=1`,
            [model, keys, identity.userId]);
            if (result.rowCount !== keys.length) throw new Error("Smoke seed refuses preconfigured tool bindings");
        }
        await client.query("COMMIT");
        return { schema: 1, project, ...identity, models, providerOrigin: "http://mock-provider:4180", paid: false };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally { client.release(); }
}

if (import.meta.main) {
    assertSmokeSeedEnvironment(process.env);
    // This script is mounted read-only at /smoke, but executes the exact
    // candidate image's database/security modules at /app/src.
    const source = process.env.CANVAS_SMOKE_SOURCE_ROOT!;
    const { createDatabase } = await import(`${source}/db.ts`);
    const security = await import(`${source}/security.ts`);
    const db: Database = createDatabase(process.env.DATABASE_URL!);
    try { console.log(JSON.stringify(await seedSmokeDatabase(db, process.env, security))); }
    finally { await db.end(); }
}
