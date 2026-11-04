export const USAGE_FAILURE_RULE_VERSION = "failure-text-v1";
export const usageFailureLabels: Record<string, string> = {
  provider_timeout: "供应商超时",
  quota: "额度或配额不足",
  invalid_parameters: "参数不合法",
  moderation: "内容审核拒绝",
  network: "网络错误",
  result_storage: "结果保存失败",
  user_cancelled: "用户取消",
  interrupted: "请求中断",
  paused: "暂停待处理",
  uncertain: "结果待核查",
  unknown: "未分类原因",
};
/** Classification only; raw provider errors, URLs, identifiers and credentials never leave this function. */
export function classifyUsageFailure(status: string, reason: unknown): string {
  if (status === "cancelled") return "user_cancelled";
  if (status === "interrupted") return "interrupted";
  if (status === "uncertain") return "uncertain";
  const text =
    typeof reason === "string" ? reason.slice(0, 16000).toLowerCase() : "";
  if (/unknown.result|uncertain|结果未知|待核查/.test(text)) return "uncertain";
  if (status === "paused") return "paused";
  if (/save|storage|s3|minio|保存|存储|落盘/.test(text))
    return "result_storage";
  if (/moderation|content.policy|safety|审核|敏感|安全策略/.test(text))
    return "moderation";
  if (/quota|credit|balance|insufficient|额度|余额|配额/.test(text))
    return "quota";
  if (/invalid.param|validation|bad.request|参数|格式不合法/.test(text))
    return "invalid_parameters";
  if (/timeout|timed.out|超时/.test(text)) return "provider_timeout";
  if (/network|econn|enotfound|socket|tls|dns|网络|连接失败/.test(text))
    return "network";
  return "unknown";
}
