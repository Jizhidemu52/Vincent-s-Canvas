export const chatUpstreamFailureReasons = [
    "authentication_failed", "access_denied", "balance_insufficient", "request_too_large", "rate_limited", "service_unavailable",
    "thinking_history_invalid", "tool_sequence_invalid", "tool_choice_unsupported", "image_input_invalid", "context_too_large",
    "parameter_unsupported", "model_unavailable", "request_invalid", "unclassified",
] as const;
export type ChatUpstreamFailureReason = typeof chatUpstreamFailureReasons[number];

const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Consume bounded error data in memory; only a fixed category may leave this function. */
export async function readChatUpstreamFailure(response: Response): Promise<ChatUpstreamFailureReason> {
    // These statuses are already specific; do not read an unnecessary body that
    // can contain echoed authorization headers or private request content.
    const statusReason = response.status === 401 ? "authentication_failed"
        : response.status === 403 ? "access_denied"
            : response.status === 402 ? "balance_insufficient"
                : response.status === 413 ? "request_too_large"
                    : response.status === 429 ? "rate_limited"
                        : response.status >= 500 ? "service_unavailable" : undefined;
    if (statusReason) {
        await response.body?.cancel().catch(() => {});
        return statusReason;
    }
    let raw = "";
    const reader = response.body?.getReader();
    if (reader) {
        const decoder = new TextDecoder();
        let bytes = 0;
        try {
            while (bytes <= MAX_ERROR_BODY_BYTES) {
                const chunk = await reader.read();
                if (chunk.done) { raw += decoder.decode(); break; }
                bytes += chunk.value.byteLength;
                if (bytes > MAX_ERROR_BODY_BYTES) { raw = ""; break; }
                raw += decoder.decode(chunk.value, { stream: true });
            }
        } catch { raw = ""; /* Retain the known HTTP failure, not a body-read error. */ }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    // Classify only the documented JSON error fields, never arbitrary HTML,
    // request echoes, or additional object properties supplied by a provider.
    let detail = "";
    try {
        const payload = JSON.parse(raw);
        const error = payload?.error;
        if (typeof error === "string") detail = error.slice(0, 8_000);
        else if (error && typeof error === "object" && !Array.isArray(error)) {
            detail = [error.type, error.code, error.message].filter(value => typeof value === "string").map(value => value.slice(0, 8_000)).join(" ");
        }
    } catch { /* Non-JSON failures remain status-only. */ }
    if (response.status === 400 || response.status === 422) {
        // Bedrock reports account/model access denial as ValidationException
        // with HTTP 400. It is not an invalid image or user prompt.
        if (/access to bedrock models is not allowed for this account/i.test(detail)) return "access_denied";
        if (/signature|thinking.*(?:invalid|must|expected)|preserv.*thinking/i.test(detail)) return "thinking_history_invalid";
        if (/tool_result|tool_use_id|tool use.*result/i.test(detail)) return "tool_sequence_invalid";
        if (/tool_choice|tool choice/i.test(detail)) return "tool_choice_unsupported";
        if (/(?:image|图片).*(?:large|size|bytes|limit|invalid|超过)|base64/i.test(detail)) return "image_input_invalid";
        if (/context.*(?:length|limit|exceed)|too many tokens|prompt.*too long/i.test(detail)) return "context_too_large";
        if (/unsupported.*(?:param|field)|unknown.*(?:param|field)|output_config/i.test(detail)) return "parameter_unsupported";
        if (/insufficient.*(?:balance|credit|quota)|balance.*insufficient|spend.*limit|usage.*limit|余额不足/i.test(detail)) return "balance_insufficient";
    }
    if ((response.status === 400 || response.status === 404) && /model.*(?:not found|unavailable|not supported|does not exist)/i.test(detail)) return "model_unavailable";
    return response.status === 400 || response.status === 422 ? "request_invalid" : "unclassified";
}

export function chatUpstreamFailureMessage(label: string, status: number, reason: ChatUpstreamFailureReason) {
    const messages: Record<ChatUpstreamFailureReason, string> = {
        authentication_failed: "对话模型服务凭据未通过验证，请管理员检查服务端 API Key。",
        access_denied: "对话模型服务没有授予本次访问权限，请管理员核查模型权限与服务限制。",
        balance_insufficient: "对话模型服务的账户计费状态或额度异常，请管理员核查上游账户。",
        request_too_large: "本轮请求超过对话模型服务的大小上限，请减少参考图或附件。",
        rate_limited: "对话模型服务触发了请求限流或用量上限，请管理员核查上游额度；暂不要连续重复发送。",
        service_unavailable: "对话模型上游服务暂时不可用，请管理员核查服务状态；当前失败不代表图片或提示词有误。",
        thinking_history_invalid: "上游未接受本轮模型思考签名或历史格式，请管理员核查上下文回放兼容性。",
        tool_sequence_invalid: "上游未接受本轮工具调用与结果的对应关系，请管理员核查工具上下文。",
        tool_choice_unsupported: "上游不支持本轮工具选择参数，请管理员核查模型适配。",
        image_input_invalid: "上游未接受本轮图片预览的格式或大小，请检查参考图并联系管理员核查。",
        context_too_large: "本轮对话上下文超过模型上限，请减少附件或在新对话中继续。",
        parameter_unsupported: "上游不支持本轮请求中的参数，请管理员核查模型适配。",
        model_unavailable: "当前对话模型在上游不可用，请管理员核查模型配置。",
        request_invalid: "上游未接受本轮请求参数，未返回可安全展示的具体原因；请保留此错误码并联系管理员核查。",
        unclassified: "上游服务未接受本轮请求，请保留此错误码并联系管理员核查。",
    };
    return `${label} ${status}: ${messages[reason]}本次请求不会自动重新提交。`;
}
