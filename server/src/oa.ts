export const OA_USERINFO_URL = "https://oa.in-choice.com.cn:82/api/api/organization/user/info_login";
export const OA_SESSION_TTL_SECONDS = 7200;
export type OaIdentity = { id: string; name: string };

export class OaError extends Error {
  constructor(readonly code: string, message: string, readonly status = 401) { super(message); }
}

/** Only the trusted OA response determines identity; never persist or log its bearer token. */
export async function verifyOaToken(token: unknown, endpoint = OA_USERINFO_URL, fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch): Promise<OaIdentity> {
  if (typeof token !== "string" || !token.trim() || token.length > 8192 || /[\s\x00-\x1f\x7f]/.test(token)) {
    throw new OaError("OA_TOKEN_INVALID", "登录凭证无效，请从企业微信 OA 入口重新打开。");
  }
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password) throw new OaError("OA_CONFIGURATION_INVALID", "OA 登录服务配置无效。", 503);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8", Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new OaError("OA_UNAVAILABLE", "暂时无法连接 OA 登录服务，请稍后从企业微信重新打开。", 503);
  }
  if (response.status === 401 || response.status === 403) throw new OaError("OA_TOKEN_INVALID", "登录凭证已失效，请从企业微信 OA 入口重新打开。");
  if (!response.ok) throw new OaError("OA_UNAVAILABLE", "OA 登录服务暂时不可用。", 503);
  const payload = await response.json().catch(() => null) as { errcode?: unknown; userid?: unknown; name?: unknown; data?: { userid?: unknown; name?: unknown } } | null;
  if (!payload || (payload.errcode !== undefined && payload.errcode !== 0 && payload.errcode !== "0")) throw new OaError("OA_TOKEN_INVALID", "登录凭证已失效，请从企业微信 OA 入口重新打开。");
  // The endpoint returns {userid,name}; the earlier PHP wrapper also accepts {errcode:0,data:{userid,name}}.
  const identity = payload.errcode === undefined ? payload : payload.data;
  const id = identity?.userid;
  const name = identity?.name;
  if (!(typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id))) || !String(id).trim() || String(id).length > 200 || typeof name !== "string" || !name.trim() || name.length > 200) {
    throw new OaError("OA_IDENTITY_INVALID", "OA 未返回有效的员工身份，请联系 OA 管理员。", 502);
  }
  return { id: String(id), name: name.trim() };
}
