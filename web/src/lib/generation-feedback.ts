/** Keep human guidance separate from the original diagnostic. Never infer that an unknown paid submission failed. */
export function generationErrorMessage(error: unknown, status?: number): string {
    const raw = error instanceof Error ? error.message : String(error || "");
    if (/待核查|勿重复|不要重复|查询暂停|停止本页查询|原请求待查询/.test(raw)) return "原任务状态尚未确认，请继续查询原任务，不要重复生成。";
    if (status === 401 || /unauthorized|session.*expired|登录.*过期/i.test(raw)) return "登录已过期，请重新登录后继续；不要重复提交尚未确认的任务。";
    if (status === 402 || /insufficient|balance|额度不足|余额不足/i.test(raw)) return "可用额度不足，请联系管理员补充额度后重试。";
    if (status === 429 || /rate.limit|too many|限流/i.test(raw)) return "服务请求较多，请稍后重试；已提交的任务请继续查询。";
    if (/content.?policy|moderation|safety|内容审核|敏感内容/i.test(raw)) return "内容未通过审核，请调整提示词或参考素材后重试。";
    if (status === 408 || status === 504 || /timeout|timed out|超时/i.test(raw)) return "服务响应超时。已提交的任务请继续查询，确认失败后再重试。";
    if (/Failed to fetch|NetworkError|network|Load failed|断网/i.test(raw)) return "网络连接失败，请检查网络；已提交的任务请继续查询，不要重复生成。";
    if (status && status >= 500) return "生成服务暂时不可用，请稍后查询原任务或联系管理员。";
    return /[\u3400-\u9fff]/.test(raw) ? raw : "操作未完成，请稍后重试或复制诊断信息联系管理员。";
}

export function generationDownloadName(title: string, extension: string, now = new Date()) {
    const safe = title.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 48) || "生成作品";
    return `${safe}_v1_${now.toISOString().replace(/[:.]/g, "-")}.${extension.replace(/^\./, "")}`;
}

export function shouldConfirmPromptReuse(current: string, next: string) {
    return Boolean(current.trim()) && current !== next;
}

export function generationErrorDiagnostic(error: unknown): string {
    if (!(error instanceof Error)) return String(error || "");
    const info = error as Error & { diagnostic?: string; status?: number; code?: string; requestId?: string; taskId?: string; cause?: unknown };
    return [info.name, info.diagnostic || info.message, info.status ? `HTTP ${info.status}` : "", info.code ? `code: ${info.code}` : "", info.requestId ? `requestId: ${info.requestId}` : "", info.taskId ? `taskId: ${info.taskId}` : "", info.cause ? generationErrorDiagnostic(info.cause) : ""].filter(Boolean).join("\n");
}
