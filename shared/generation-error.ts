/** Employee-facing task failures. Raw provider diagnostics remain in task storage/admin APIs. */
export const IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX = "渠道原件已保存到素材库，但图片后处理未完成";
export const IMAGE_RESULT_POSTPROCESS_FAILURE_CODE = "IMAGE_RESULT_PROCESSING_FAILED";

export function publicGenerationFailure(reason: unknown, status?: string): string {
    if (status === "cancelled") return "任务已取消。";
    const raw = typeof reason === "string" ? reason : "";
    if (raw.startsWith(`${IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX}：`) || raw.startsWith(`${IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX}；`))
        return `${IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX}；请联系管理员检查已保存原件，不要重复生成。`;
    if (status === "paused" || /待核查|勿重复|不要重复|submission.{0,20}(unknown|uncertain)|query.{0,12}paused/i.test(raw))
        return "原任务结果待核查，请查询原任务或联系管理员；不要重复生成。";
    // Only the exact upload adapter message proves generation never started.
    // A generic 429 may belong to a submitted task and must keep its old guidance.
    for (const purpose of ["图片", "视频"]) {
        const uploadLimit = `参考图上传已被服务商限制，尚未提交${purpose}生成；请联系管理员检查上传配额，恢复后再试。`;
        if (raw === `APIMart 参考图上传失败（429），尚未提交${purpose}生成` || raw === uploadLimit) return uploadLimit;
    }
    // These bounded local size limits are actionable, not raw provider diagnostics.
    const referenceLimit = /^单张参考图超过 (10|12|20) MB，请压缩后重试$/.exec(raw);
    if (referenceLimit) return `参考图超过当前模型单张 ${referenceLimit[1]} MiB 上限，请另存较小副本或切换模型；原图未修改，尚未提交生成。`;
    if ([
        "参考素材的原始文件缺失，请重新上传原图后再生成。",
        "暂时无法读取参考素材，请稍后重试或联系管理员检查对象存储。",
    ].includes(raw)) return raw;
    // Exact locally-authored recipe failures are safe and identify a setup issue,
    // not unsupported image parameters. Never echo arbitrary matching fragments.
    if ([
        "管理员尚未配置此场景的优化配方，未提交生成",
        "管理员尚未启用此场景的配方版本，未提交生成",
        "此场景的提示词优化已停用，未提交生成",
        "图片助手配方暂不可用，未提交生成。",
        "图片助手配方过长，未提交生成，请管理员精简配方。",
    ].includes(raw)) return raw;
    if (/content.?policy|moderation|safety|nsfw|内容审核|敏感内容|违规/i.test(raw))
        return "内容未通过审核，请调整提示词或参考素材后重试。";
    if (/insufficient|balance|quota.?exceeded|额度不足|余额不足|积分不足/i.test(raw))
        return "可用额度不足，请联系管理员检查额度后重试。";
    if (/invalid.?api.?key|authentication|unauthorized|forbidden|凭据|鉴权|\b40[13]\b/i.test(raw))
        return "生成渠道暂时不可用，请联系管理员检查服务配置。";
    if (/requires? \d|unsupported|not.support|invalid.{0,20}(parameter|size|resolution|format)|output_compression|reference.{0,15}(limit|count)|不支持|参数|参考图.{0,12}(数量|张数)|必须为/i.test(raw))
        return "当前模型不支持这组参数或参考素材，请检查尺寸、格式和参考图数量后重试。";
    if (/rate.limit|too.many|overloaded|capacity|\b429\b|限流|繁忙/i.test(raw))
        return "生成服务繁忙，请稍后重试；已有任务请先查询原状态。";
    if (/timeout|timed.out|\b(?:408|504)\b|超时/i.test(raw))
        return "生成服务响应超时，请先确认原任务状态，再决定是否重试。";
    if (/network|fetch|certificate|\b50[023]\b|网络|连接失败|状态查询失败/i.test(raw))
        return "生成服务连接异常，请稍后查询原任务或联系管理员。";
    return "生成未完成，请检查提示词与素材；仍有问题请提供任务编号联系管理员。";
}

export function publicTaskFailurePayload(body: unknown): unknown {
    if (!body || typeof body !== "object" || Array.isArray(body)) return body;
    const value = body as Record<string, unknown>;
    const task = (item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const data = item as Record<string, unknown>;
        if (!data.failureReason) return item;
        const { lastFailure: raw, ...rest } = data;
        const detail = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
        // Stable recovery classification is not a raw provider diagnostic. Keep
        // only its protocol fields, never messages, URLs or nested error objects.
        const safeDetail = detail && ["preflight", "submission", "polling", "download", "result_store", "postprocess"].includes(String(detail.phase))
            && typeof detail.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(detail.code)
            ? { phase: detail.phase, code: detail.code, ...(typeof detail.httpStatus === "number" && Number.isInteger(detail.httpStatus) && detail.httpStatus >= 100 && detail.httpStatus <= 599 ? { httpStatus: detail.httpStatus } : {}) } : undefined;
        return { ...rest, ...(safeDetail ? { lastFailure: safeDetail } : {}), failureReason: publicGenerationFailure(data.failureReason, String(data.status || "")) };
    };
    const result = { ...value };
    if (value.task) {
        result.task = task(value.task);
        const original = value.task as Record<string, unknown>;
        if (original.failureReason && value.message === original.failureReason) result.message = (result.task as Record<string, unknown>).failureReason;
    }
    if (Array.isArray(value.tasks)) result.tasks = value.tasks.map(task);
    if (Array.isArray(value.failures)) result.failures = value.failures.map(item => item && typeof item === "object" && typeof item.reason === "string" ? { ...item, reason: publicGenerationFailure(item.reason) } : item);
    return result;
}
