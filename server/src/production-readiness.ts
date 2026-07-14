export type ReadinessCheck = { key: string; level: "pass" | "warning" | "error"; message: string };

type Options = { requireWeCom?: boolean; allowMockMode?: boolean };

const required = [
    "POSTGRES_PASSWORD", "NODE_ENV", "SESSION_COOKIE_NAME", "SESSION_TTL_SECONDS", "TRUST_PROXY",
    "BOOTSTRAP_ADMIN_USERNAME", "BOOTSTRAP_ADMIN_DISPLAY_NAME", "BOOTSTRAP_ADMIN_PASSWORD",
    "PROVIDER_ENCRYPTION_KEY", "WORKER_CONCURRENCY", "TASK_MOCK_MODE",
    "S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
] as const;
const weComFields = ["WECOM_CORP_ID", "WECOM_AGENT_ID", "WECOM_SECRET", "WECOM_CALLBACK_URL"] as const;

export function validateProductionEnvironment(env: Record<string, string | undefined>, options: Options = {}) {
    const checks: ReadinessCheck[] = [];
    const add = (key: string, level: ReadinessCheck["level"], message: string) => checks.push({ key, level, message });
    const present = (key: string) => Boolean(env[key]?.trim() && !env[key]!.startsWith("replace-with"));

    for (const key of required) {
        const value = env[key]?.trim();
        if (!value || value.startsWith("replace-with")) add(key, "error", `${key} 尚未填写正式值`);
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

    const configuredWeCom = weComFields.filter((key) => Boolean(env[key]?.trim()));
    if (configuredWeCom.length === 0 && options.requireWeCom) {
        add("WECOM", "error", "要求企业微信登录，但四项企业微信配置均为空");
    } else if (configuredWeCom.length > 0 && configuredWeCom.length < weComFields.length) {
        add("WECOM", "error", `企业微信配置不完整，缺少 ${weComFields.filter((key) => !env[key]?.trim()).join("、")}`);
    } else if (configuredWeCom.length === weComFields.length) {
        validateUrl(env, "WECOM_CALLBACK_URL", true, add);
        try {
            const callback = new URL(env.WECOM_CALLBACK_URL!);
            add("WECOM_CALLBACK_PATH", callback.pathname === "/api/auth/wecom/callback" ? "pass" : "error", callback.pathname === "/api/auth/wecom/callback" ? "企业微信回调路径正确" : "企业微信回调路径必须为 /api/auth/wecom/callback");
        } catch { /* URL check already reports the error. */ }
    } else {
        add("WECOM", "warning", "企业微信未启用，账号密码登录仍可使用");
    }

    if (env.BOOTSTRAP_ADMIN_PASSWORD && !env.BOOTSTRAP_ADMIN_PASSWORD.startsWith("replace-with")) {
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
