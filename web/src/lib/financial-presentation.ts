// Display-only projection. Never use this to build API requests or alter stored data.
const financialKeys = new Set([
    "credits", "creditCost", "creditCostOverride", "rmbCostOverride", "creditBalance", "creditLimit", "monthlyCreditLimit", "temporaryCreditAdjustment",
    "creditResetAt", "creditPeriodStart", "totalUsedCredits", "totalCredits", "usedCredits", "remainingCredits",
    "creditsEnabled", "creditPolicy", "quotaRemaining", "totalRmbCost", "rmbCost", "rmbCostPerUnit",
    "costUsd", "costRmb", "estimatedRmbCost", "actualRmbCost", "settledRmbCost", "estimatedCostUsd",
    "estimatedCost", "actualCost", "totalCost", "priceCredits", "priceRmb", "priceVersion", "priceVersionId",
    "billing", "billingSnapshot", "pricing", "pricingSnapshot", "pricingConfig", "costBreakdown",
    "credit_cost", "credit_cost_override", "rmb_cost_override", "credit_balance", "credit_limit", "monthly_credit_limit", "temporary_credit_adjustment",
    "credit_reset_at", "credit_period_start", "total_rmb_cost", "rmb_cost", "cost_usd", "price_version_id",
]);

export function isFinancialDisplayField(key: string): boolean {
    return financialKeys.has(key);
}

export function omitFinancialFields(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(omitFinancialFields);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !isFinancialDisplayField(key)).map(([key, item]) => [key, omitFinancialFields(item)]));
}

export function formatNonFinancialJson(value: unknown): string {
    return JSON.stringify(omitFinancialFields(value), null, 2) ?? "";
}

export function formatNonFinancialPreview(value: string): string {
    try { return formatNonFinancialJson(JSON.parse(value)); }
    catch { return value; }
}

/** Known system coverage/analysis explanations only; never apply to prompts or user-authored text. */
export function usageDisplayExplanation(value: string): string {
    if (value.startsWith("生成成本汇总已保存的成功生成历史人民币金额")) return "";
    if (value === "分析调用可能产生费用；仅在明确确认后调用一次，不自动重试。") return "分析仅在明确确认后调用一次，不自动重试。";
    if (value === "仅发送此预览内容；无员工姓名、用户 ID、原图或完整提示词。") return "提交使用服务端冻结的完整汇总；当前预览仅展示可见统计字段，不含员工姓名、用户 ID、原图或完整提示词。";
    return value.replace(/^当前筛选中有 \d+ 个成功任务缺少成功结算历史，费用未计入且不补估；/, "")
        .replace(/^已保存历史金额不按新单价重算；/, "")
        .replace(/^历史成本按原记录汇总，不按当前单价追溯重算[；。]?/, "");
}

const financialAuditActions = new Set([
    "account.credits.adjust", "account.credits.set", "account.credits_adjusted", "account.credits_set",
    "account.monthly_credit_updated", "credits.adjust", "credits.set", "credits.adjusted", "credits.balance_set",
    "credit_policy.update", "credit_policy.updated", "credit_policy.policy_changed", "price.publish", "price.published",
    "price.created", "price.updated", "price.deleted", "price.testing", "price.draft_created", "pricing.updated",
    "credits.policy_changed", "layer_studio.price_updated",
    "group.credit_policy_updated", "group.credit_requested", "group.credit_request_rejected",
    "group.credit_request_approved", "group.credit_contributed",
]);

export const isFinancialAuditAction = (action: string): boolean => financialAuditActions.has(action);
