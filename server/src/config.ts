import { z } from "zod";

const schema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3100),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    SESSION_COOKIE_NAME: z.string().min(1).default("wireless_canvas_session"),
    SESSION_TTL_SECONDS: z.coerce.number().int().min(900).max(604800).default(28800),
    TRUST_PROXY: z.enum(["true", "false"]).default("false"),
    BOOTSTRAP_ADMIN_USERNAME: z.string().min(1).optional(),
    BOOTSTRAP_ADMIN_DISPLAY_NAME: z.string().min(1).default("超级管理员"),
    BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
    WECOM_CORP_ID: z.string().optional(),
    WECOM_AGENT_ID: z.string().optional(),
    WECOM_SECRET: z.string().optional(),
    WECOM_CALLBACK_URL: z.string().url().optional().or(z.literal("")),
    MFA_ENCRYPTION_KEY: z.string().optional(),
    PROVIDER_ENCRYPTION_KEY: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
    const config = schema.parse(env);
    if (config.NODE_ENV === "production" && (!config.MFA_ENCRYPTION_KEY || Buffer.from(config.MFA_ENCRYPTION_KEY, "base64").length !== 32)) {
        throw new Error("MFA_ENCRYPTION_KEY must be a base64-encoded 32-byte key in production");
    }
    if (config.NODE_ENV === "production" && (!config.PROVIDER_ENCRYPTION_KEY || Buffer.from(config.PROVIDER_ENCRYPTION_KEY, "base64").length !== 32)) {
        throw new Error("PROVIDER_ENCRYPTION_KEY must be a base64-encoded 32-byte key in production");
    }
    return config;
}
