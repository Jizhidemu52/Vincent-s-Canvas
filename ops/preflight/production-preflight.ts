import { SQL } from "bun";
import { validateProductionEnvironment, type ReadinessCheck } from "../../server/src/production-readiness";

async function verifyBootstrapAdministrator(connectionString: string | undefined): Promise<ReadinessCheck> {
    const key = "BOOTSTRAP_ADMIN_STATE";
    if (!connectionString?.trim()) return {
        key, level: "error", message: "部署后复验缺少 DATABASE_URL，管理员状态未验证；请按生产手册在 Compose 网络中运行预检",
    };
    let database: SQL | undefined;
    try {
        const url = new URL(connectionString);
        if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
            return { key, level: "error", message: "DATABASE_URL 必须是 PostgreSQL 连接地址，管理员状态未验证" };
        }
        database = new SQL(connectionString, { max: 1, connectionTimeout: 5, idleTimeout: 1 });
        const rows = await database.begin("read only", async (transaction) => {
            await transaction`SET LOCAL statement_timeout = '5s'`;
            return transaction<{ ready: boolean }[]>`
                SELECT EXISTS (
                    SELECT 1 FROM users WHERE role='super_admin' AND status='active'
                      AND must_change_password=false AND password_hash IS NOT NULL AND password_hash<>''
                ) AS ready`;
        });
        return rows[0]?.ready === true
            ? { key, level: "pass", message: "已只读确认存在启用、可密码登录且完成首次改密的超级管理员" }
            : { key, level: "error", message: "尚未确认可用且完成首次改密的超级管理员；保留有效初始密码并完成首次引导后再复验" };
    } catch {
        // Driver errors may contain connection credentials: never forward them into preflight output.
        return { key, level: "error", message: "无法只读确认管理员状态；请检查数据库连接、迁移和查询权限，不能按已初始化环境放行" };
    } finally {
        await database?.close({ timeout: 1 }).catch(() => undefined);
    }
}

export async function collectProductionPreflight(env: Record<string, string | undefined>, args: string[]) {
    const bootstrap = args.includes("--after-bootstrap") ? await verifyBootstrapAdministrator(env.DATABASE_URL) : undefined;
    return [...(bootstrap ? [bootstrap] : []), ...validateProductionEnvironment(env, {
        requireWeCom: args.includes("--require-wecom"),
        allowMockMode: args.includes("--allow-mock"),
        bootstrapAdminVerified: bootstrap?.level === "pass",
    })];
}

if (import.meta.main) {
    const checks = await collectProductionPreflight(process.env, Bun.argv);
    const labels = { pass: "通过", warning: "提醒", error: "错误" } as const;
    for (const check of checks) console.log(`[${labels[check.level]}] ${check.message}`);
    const errors = checks.filter((check) => check.level === "error");
    console.log(`\n生产预检：${checks.filter((check) => check.level === "pass").length} 项通过，${checks.filter((check) => check.level === "warning").length} 项提醒，${errors.length} 项错误。`);
    if (errors.length) process.exit(1);
}
