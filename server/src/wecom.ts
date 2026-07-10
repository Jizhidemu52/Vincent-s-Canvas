import type { AppConfig } from "./config";

type WeComConfig = Pick<AppConfig, "WECOM_CORP_ID" | "WECOM_AGENT_ID" | "WECOM_SECRET" | "WECOM_CALLBACK_URL">;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const requiredFields = ["WECOM_CORP_ID", "WECOM_AGENT_ID", "WECOM_SECRET", "WECOM_CALLBACK_URL"] as const;

export class WeComError extends Error {
    constructor(public code: string, message: string) { super(message); }
}

export function getWeComStatus(config: WeComConfig) {
    const missing = requiredFields.filter((field) => !config[field]);
    const callbackUrl = config.WECOM_CALLBACK_URL || null;
    const callbackUsesHttps = callbackUrl ? new URL(callbackUrl).protocol === "https:" : false;
    return { configured: missing.length === 0, missing, callbackUrl, callbackUsesHttps };
}

export function createWeComAuthorizationUrl(config: WeComConfig, state: string) {
    const status = getWeComStatus(config);
    if (!status.configured) throw new WeComError("WECOM_NOT_CONFIGURED", "企业微信登录尚未由公司 IT 配置完整");
    const params = new URLSearchParams({
        appid: config.WECOM_CORP_ID!,
        agentid: config.WECOM_AGENT_ID!,
        redirect_uri: config.WECOM_CALLBACK_URL!,
        state,
    });
    return `https://open.work.weixin.qq.com/wwopen/sso/qrConnect?${params}`;
}

export async function exchangeWeComCode(config: WeComConfig, code: string, fetcher: FetchLike = fetch) {
    const status = getWeComStatus(config);
    if (!status.configured) throw new WeComError("WECOM_NOT_CONFIGURED", "企业微信登录尚未配置");

    const tokenUrl = new URL("https://qyapi.weixin.qq.com/cgi-bin/gettoken");
    tokenUrl.searchParams.set("corpid", config.WECOM_CORP_ID!);
    tokenUrl.searchParams.set("corpsecret", config.WECOM_SECRET!);
    const tokenPayload = await fetchJson(fetcher, tokenUrl) as { errcode?: number; errmsg?: string; access_token?: string };
    if (tokenPayload.errcode !== 0 || !tokenPayload.access_token) {
        throw new WeComError("WECOM_TOKEN_FAILED", `企业微信访问令牌获取失败：${tokenPayload.errmsg || tokenPayload.errcode || "未知错误"}`);
    }

    const userInfoUrl = new URL("https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo");
    userInfoUrl.searchParams.set("access_token", tokenPayload.access_token);
    userInfoUrl.searchParams.set("code", code);
    const userPayload = await fetchJson(fetcher, userInfoUrl) as { errcode?: number; errmsg?: string; userid?: string; UserId?: string };
    const userId = userPayload.userid || userPayload.UserId;
    if (userPayload.errcode !== 0 || !userId) {
        throw new WeComError("WECOM_USER_LOOKUP_FAILED", `企业微信成员身份获取失败：${userPayload.errmsg || userPayload.errcode || "未知错误"}`);
    }
    return { userId };
}

async function fetchJson(fetcher: FetchLike, url: URL) {
    try {
        const response = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new WeComError("WECOM_HTTP_ERROR", `企业微信接口返回 HTTP ${response.status}`);
        return await response.json() as unknown;
    } catch (error) {
        if (error instanceof WeComError) throw error;
        throw new WeComError("WECOM_UNAVAILABLE", "企业微信接口暂时不可用，请稍后重试");
    }
}
