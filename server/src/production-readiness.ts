import { OA_USERINFO_URL } from "./oa";

export type ReadinessCheck = { key: string; level: "pass" | "warning" | "error"; message: string };

type Options = { requireWeCom?: boolean; allowMockMode?: boolean; bootstrapAdminVerified?: boolean };

const required = [
    "POSTGRES_PASSWORD", "NODE_ENV", "SESSION_COOKIE_NAME", "SESSION_TTL_SECONDS", "TRUST_PROXY",
    "BOOTSTRAP_ADMIN_USERNAME", "BOOTSTRAP_ADMIN_DISPLAY_NAME",
    "PROVIDER_ENCRYPTION_KEY", "WORKER_CONCURRENCY", "TASK_MOCK_MODE",
    "S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
] as const;

export function validateProductionEnvironment(env: Record<string, string | undefined>, options: Options = {}) {
    const checks: ReadinessCheck[] = [];
    const add = (key: string, level: ReadinessCheck["level"], message: string) => checks.push({ key, level, message });
    const present = (key: string) => Boolean(env[key]?.trim() && !env[key]!.trim().startsWith("replace-with"));

    for (const key of required) {
        const value = env[key]?.trim();
        if (!value || value.startsWith("replace-with")) add(key, "error", `${key} 尚未填写正式值`);
    }

    if (env.BOOTSTRAP_ADMIN_PASSWORD === undefined && options.bootstrapAdminVerified === true) {
        add("BOOTSTRAP_ADMIN_PASSWORD", "pass", "已确认现有管理员完成改密，初始密码已从环境中移除");
    } else if (!present("BOOTSTRAP_ADMIN_PASSWORD")) {
        add("BOOTSTRAP_ADMIN_PASSWORD", "error", options.bootstrapAdminVerified
            ? "初始密码变量仍为空值或示例值；完成改密后应删除整行，不能保留 BOOTSTRAP_ADMIN_PASSWORD="
            : "首次部署必须填写至少 12 位正式初始密码；已初始化环境请使用 --after-bootstrap 只读复验");
    }

    if (present("NODE_ENV")) add("NODE_ENV", env.NODE_ENV === "production" ? "pass" : "error", env.NODE_ENV === "production" ? "运行模式为 production" : "NODE_ENV 必须为 production");
    if (present("TRUST_PROXY")) add("TRUST_PROXY", env.TRUST_PROXY === "true" ? "pass" : "error", env.TRUST_PROXY === "true" ? "已启用单层反向代理信任" : "TRUST_PROXY 必须为 true");
    if (present("TASK_MOCK_MODE")) add("TASK_MOCK_MODE", env.TASK_MOCK_MODE === "false" || options.allowMockMode ? "pass" : "error", env.TASK_MOCK_MODE === "false" ? "正式模型任务模式" : options.allowMockMode ? "测试环境允许模拟任务" : "正式上线前必须关闭 TASK_MOCK_MODE");

    if (present("SESSION_TTL_SECONDS")) validateInteger(env, "SESSION_TTL_SECONDS", 900, 604800, add);
    if (present("WORKER_CONCURRENCY")) validateInteger(env, "WORKER_CONCURRENCY", 1, 40, add);
    if (present("POSTGRES_PASSWORD")) validateLength(env, "POSTGRES_PASSWORD", 16, add);
    if (present("BOOTSTRAP_ADMIN_PASSWORD")) validateLength(env, "BOOTSTRAP_ADMIN_PASSWORD", 12, add);
    if (present("S3_SECRET_ACCESS_KEY")) validateLength(env, "S3_SECRET_ACCESS_KEY", 16, add);
    if (present("PROVIDER_ENCRYPTION_KEY")) validateBase64Key(env, "PROVIDER_ENCRYPTION_KEY", add);
    if (present("S3_ENDPOINT")) validateUrl(env, "S3_ENDPOINT", false, add);

    if (env.OA_LOGIN_ENABLED === "true") {
        let valid = false;
        try {
            const endpoint = new URL(env.OA_USERINFO_URL ?? OA_USERINFO_URL);
            valid = endpoint.protocol === "https:" && !endpoint.username && !endpoint.password;
        } catch { /* Report a configuration error without echoing credentials. */ }
        add("OA_USERINFO_URL", valid ? "pass" : "error", valid ? "OA 身份接口使用 HTTPS，仍须完成公司联调" : "OA_USERINFO_URL 必须是无内嵌凭据的可信 HTTPS 地址");
        add("COMPANY_NETWORK", "warning", "公司外访问限制须由 IT 网关/防火墙覆盖网页、API、媒体及后端端口，并从公司外实际验收");
    }

    if (options.requireWeCom) {
        add("WECOM", "error", "本版复用公司 OA，不提供独立扫码；请配置 OA_LOGIN_ENABLED");
    } else {
        add("WECOM", "pass", "画布不提供独立企业微信扫码，忽略旧扫码配置");
    }

    if (present("BOOTSTRAP_ADMIN_PASSWORD")) {
        add("BOOTSTRAP_ADMIN_PASSWORD_CLEANUP", "warning", "首位超级管理员创建并改密后，应从服务器环境中删除初始密码");
    }
    return checks;
}

function validateInteger(env: Record<string, string | undefined>, key: string, min: number, max: number, add: (key: string, level: ReadinessCheck["level"], message: string) => void) {
    const value = Number(env[key]);
    add(key, Number.isInteger(value) && value >= min && value <= max ? "pass" : "error", Number.isInteger(value) && value >= min && value <= max ? `${key} 数值有效` : `${key} 必须是 ${min} 到 ${max} 的整数`);
}

function validateLength(env: Record<string, string | undefined>, key: string, min: number, add: (key: string, level: ReadinessCheck["level"], message: string) => void) {
    const value = env[key] ?? "";
    add(key, value.length >= min && !value.startsWith("replace-with") ? "pass" : "error", value.length >= min && !value.startsWith("replace-with") ? `${key} 长度符合要求` : `${key} 至少需要 ${min} 个字符且不能使用示例值`);
}

function validateBase64Key(env: Record<string, string | undefined>, key: string, add: (key: string, level: ReadinessCheck["level"], message: string) => void) {
    let valid = false;
    try { valid = Buffer.from(env[key] ?? "", "base64").length === 32; } catch { valid = false; }
    add(key, valid ? "pass" : "error", valid ? `${key} 是 32 字节 Base64 密钥` : `${key} 必须是 32 字节 Base64 密钥`);
}

function validateUrl(env: Record<string, string | undefined>, key: string, httpsOnly: boolean, add: (key: string, level: ReadinessCheck["level"], message: string) => void) {
    try {
        const url = new URL(env[key] ?? "");
        const valid = !httpsOnly || url.protocol === "https:";
        add(key, valid ? "pass" : "error", valid ? `${key} 地址有效` : `${key} 必须使用 HTTPS`);
    } catch { add(key, "error", `${key} 不是有效 URL`); }
}
