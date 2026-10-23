import { OA_USERINFO_URL } from "./oa";

export type ReadinessCheck = { key: string; level: "pass" | "warning" | "error"; message: string };

type Options = { requireWeCom?: boolean; allowMockMode?: boolean; bootstrapAdminVerified?: boolean };

const required = [
    "POSTGRES_PASSWORD", "NODE_ENV", "SESSION_COOKIE_NAME", "SESSION_TTL_SECONDS", "TRUST_PROXY",
    "BOOTSTRAP_ADMIN_USERNAME", "BOOTSTRAP_ADMIN_DISPLAY_NAME",
    "PROVIDER_ENCRYPTION_KEY", "WORKER_CONCURRENCY", "TASK_MOCK_MODE",
    "S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
    "BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY", "BACKUP_AGE_RECIPIENT",
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
    const authenticated = env.AUTH_ENABLED === "true" || env.OA_LOGIN_ENABLED === "true";
    add("AUTHENTICATION", authenticated ? "pass" : "error", authenticated ? "已开启用户身份验证" : "生产环境必须开启 AUTH_ENABLED 或 OA_LOGIN_ENABLED，不能匿名调用付费服务");
    add("HTTPS_GATEWAY", "warning", "生产 Cookie 仅通过 HTTPS 发送；必须在回环 HTTP 端口前配置可信 HTTPS 网关，不支持直接用 HTTP IP 登录");
    if (env.WEB_BIND_HOST && !["127.0.0.1", "::1"].includes(env.WEB_BIND_HOST)) add("WEB_BIND_HOST", "warning", "网页端口绑定非回环地址，须核实防火墙及 HTTPS 网关是否覆盖所有入口");

    if (present("SESSION_TTL_SECONDS")) validateInteger(env, "SESSION_TTL_SECONDS", 900, 604800, add);
    if (present("WORKER_CONCURRENCY")) validateInteger(env, "WORKER_CONCURRENCY", 1, 40, add);
    if (present("POSTGRES_PASSWORD")) validateLength(env, "POSTGRES_PASSWORD", 16, add);
    if (present("BOOTSTRAP_ADMIN_PASSWORD")) validateLength(env, "BOOTSTRAP_ADMIN_PASSWORD", 12, add);
    if (present("S3_SECRET_ACCESS_KEY")) validateLength(env, "S3_SECRET_ACCESS_KEY", 16, add);
    if (present("PROVIDER_ENCRYPTION_KEY")) validateBase64Key(env, "PROVIDER_ENCRYPTION_KEY", add);
    if (present("S3_ENDPOINT")) validateUrl(env, "S3_ENDPOINT", false, add);
    if (present("BACKUP_S3_ENDPOINT")) {
        validateUrl(env, "BACKUP_S3_ENDPOINT", true, add);
        try {
            const independent = new URL(env.BACKUP_S3_ENDPOINT!).hostname !== new URL(env.S3_ENDPOINT!).hostname;
            add("BACKUP_FAILURE_DOMAIN", independent ? "warning" : "error", independent ? "备份地址与源不同；仍须确认物理主机/磁盘故障域独立，并配置 bucket 版本生命周期" : "备份不能使用业务存储所在主机（即使端口或 bucket 不同）");
        } catch { /* URL validation reports missing/invalid endpoints. */ }
    }
    if (present("BACKUP_AGE_RECIPIENT")) add("BACKUP_AGE_RECIPIENT", /^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(env.BACKUP_AGE_RECIPIENT!) ? "pass" : "error", "备份 age 公钥须符合格式；实际密钥校验由备份工具执行，对应私钥须离线保管");

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
        add("WECOM", env.AUTH_ENABLED === "true" && env.OA_LOGIN_ENABLED !== "true" ? "pass" : "error", "独立企业微信扫码要求 AUTH_ENABLED=true 且 OA_LOGIN_ENABLED=false");
        for (const key of ["WECOM_CORP_ID", "WECOM_AGENT_ID", "WECOM_SECRET", "WECOM_CALLBACK_URL"]) {
            if (!present(key)) add(key, "error", `${key} 尚未填写正式值`);
        }
        if (present("WECOM_CALLBACK_URL")) validateUrl(env, "WECOM_CALLBACK_URL", true, add);
    } else {
        add("WECOM", "pass", "未要求独立企业微信扫码验收；如启用请使用 --require-wecom 检查");
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
        const valid = ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && (!httpsOnly || url.protocol === "https:");
        add(key, valid ? "pass" : "error", valid ? `${key} 地址有效` : `${key} 必须使用 HTTPS`);
    } catch { add(key, "error", `${key} 不是有效 URL`); }
}
