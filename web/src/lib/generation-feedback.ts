import { publicGenerationFailure } from "../../../shared/generation-error";

/** Only explicit pre-admission business codes prove that no generation was submitted. */
export function generationPreSubmissionMessage(code?: string): string | undefined {
    if (code === "PROMPT_RECIPE_UNAVAILABLE") return "当前场景的优化配方暂不可用，请联系管理员检查配方版本和模型配置；尚未提交生成。";
    if (code === "ASSET_OBJECT_MISSING") return "参考素材原文件缺失，请重新上传同一份原文件或联系管理员恢复；尚未提交生成。";
}

export function generationSubmissionRejected(status: number, code?: string): boolean {
    return Boolean(generationPreSubmissionMessage(code)) || (status >= 400 && status < 500 && status !== 408 && !["PROMPT_OPTIMIZING", "PROMPT_SUBMISSION_UNCERTAIN"].includes(code || ""));
}

/** Keep human guidance separate from the original diagnostic. Never infer that an unknown paid submission failed. */
export function generationErrorMessage(error: unknown, status?: number, code?: string): string {
    const notSubmitted = generationPreSubmissionMessage(code);
    if (notSubmitted) return notSubmitted;
    const raw = error instanceof Error ? error.message : String(error || "");
    if (/暂无法恢复上游查询|提交结果待核查/.test(raw)) return "暂时无法获取结果，需要管理员协助。可先刷新进度，不会重新生成。";
    if (/待核查|勿重复|不要重复|查询暂停|停止本页查询|原请求待查询/.test(raw)) return "暂时无法获取进度，请稍后再试；刷新进度不会重新生成。";
    if (status === 401 || /unauthorized|session.*expired|登录.*过期/i.test(raw)) return "登录已过期，请重新登录后继续；不要重复提交尚未确认的任务。";
    if (status === 402 || /insufficient|balance|额度不足|余额不足/i.test(raw)) return "可用额度不足，请联系管理员补充额度后重试。";
    if (status === 429 || /rate.limit|too many|限流/i.test(raw)) return "服务请求较多，请稍后重试；已提交的任务请继续查询。";
    if (/content.?policy|moderation|safety|内容审核|敏感内容/i.test(raw)) return "内容未通过审核，请调整提示词或参考素材后重试。";
    if (status === 408 || status === 504 || /timeout|timed out|超时/i.test(raw)) return "服务响应超时。已提交的任务请继续查询，确认失败后再重试。";
    if (/Failed to fetch|NetworkError|network|Load failed|断网/i.test(raw)) return "网络连接失败，请检查网络；已提交的任务请继续查询，不要重复生成。";
    if (status && status >= 500) return "生成服务暂时不可用，请稍后查询原任务或联系管理员。";
    if (/requires? \d|unsupported|not.support|invalid.{0,20}(parameter|size|resolution|format)|output_compression|invalid.?api.?key|certificate|\b(?:403|429|502|503|504)\b/i.test(raw)) return publicGenerationFailure(raw);
    return /[\u3400-\u9fff]/.test(raw) ? raw : "操作未完成，请稍后重试或复制诊断信息联系管理员。";
}

export function generationDownloadName(title: string, extension: string, now = new Date()) {
    const safe = title.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 48) || "生成作品";
    return `${safe}_v1_${now.toISOString().replace(/[:.]/g, "-")}.${extension.replace(/^\./, "")}`;
}

export function shouldConfirmPromptReuse(current: string, next: string) {
    return Boolean(current.trim()) && current !== next;
}

export function generationErrorDiagnostic(error: unknown, context: { requestId?: string; taskId?: string } = {}): string {
    if (!(error instanceof Error)) return [String(error || ""), context.requestId ? `requestId: ${context.requestId}` : "", context.taskId ? `taskId: ${context.taskId}` : ""].filter(Boolean).join("\n");
    const info = error as Error & { diagnostic?: string; status?: number; code?: string; requestId?: string; taskId?: string; cause?: unknown };
    const requestId = info.requestId || context.requestId, taskId = info.taskId || context.taskId;
    return [info.name, info.diagnostic || info.message, info.status ? `HTTP ${info.status}` : "", info.code ? `code: ${info.code}` : "", requestId ? `requestId: ${requestId}` : "", taskId ? `taskId: ${taskId}` : "", info.cause ? generationErrorDiagnostic(info.cause) : ""].filter(Boolean).join("\n");
}
