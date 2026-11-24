import { SQL } from "bun";
import { createClient } from "redis";
import { loadConfig } from "./src/config";
import { ObjectStorage } from "./src/object-storage";
import { validateProductionEnvironment } from "./src/production-readiness";

async function databaseProbe() {
    const connection = process.env.DATABASE_URL;
    if (!connection || !["postgres:", "postgresql:"].includes(new URL(connection).protocol)) {
        return { postgres: false, bootstrapAdminVerified: false };
    }
    const db = new SQL(connection, { max: 1, connectionTimeout: 5, idleTimeout: 1 });
    try {
        const rows = await db.begin("read only", async transaction => {
            await transaction`SET LOCAL statement_timeout = '5s'`;
            return transaction<{ ready: boolean }[]>`
                SELECT EXISTS (SELECT 1 FROM users WHERE role='super_admin' AND status='active'
                    AND must_change_password=false AND password_hash IS NOT NULL AND password_hash<>'') AS ready`;
        });
        return { postgres: true, bootstrapAdminVerified: rows[0]?.ready === true };
    } finally {
        await db.close({ timeout: 1 });
    }
}

async function redisProbe() {
    const url = process.env.REDIS_URL;
    if (!url) return false;
    const redis = createClient({ url, socket: { connectTimeout: 5_000, reconnectStrategy: false } });
    redis.on("error", () => {});
    try {
        await redis.connect();
        return (await redis.ping()) === "PONG";
    } finally {
        if (redis.isOpen) redis.destroy();
    }
}

async function storageProbe() {
    const storage = new ObjectStorage(loadConfig());
    if (!storage.configured) return false;
    await storage.listKeys("", { maxKeys: 1, abortSignal: AbortSignal.timeout(5_000) });
    return true;
}

const [{ postgres, bootstrapAdminVerified }, redis, storage] = await Promise.all([
    databaseProbe().catch(() => ({ postgres: false, bootstrapAdminVerified: false })),
    redisProbe().catch(() => false),
    storageProbe().catch(() => false),
]);
const rows = validateProductionEnvironment(process.env, { bootstrapAdminVerified });
const errors = rows.filter(row => row.level === "error").map(row => row.key);
const warnings = rows.filter(row => row.level === "warning").map(row => row.key);
console.log(JSON.stringify({ postgres, bootstrapAdminVerified, redis, storage, errors, warnings }));
