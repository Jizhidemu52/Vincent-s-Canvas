export type ImageTaskFailurePhase = "preflight" | "submission" | "polling" | "download" | "result_store";

export type ImageTaskFailureDetail = {
  phase: ImageTaskFailurePhase;
  code: string;
  httpStatus?: number;
};

// Diagnostics are persisted and returned to clients. Never copy provider messages,
// URLs, credentials, arbitrary error codes, or nested error objects into them.
const safeCodes = new Set([
  "PROVIDER_SUBMISSION_HTTP_ERROR", "PROVIDER_POLL_HTTP_ERROR", "PROVIDER_TERMINAL_FAILURE",
  "PROVIDER_TASK_ID_MISSING", "PROVIDER_RESULT_MISSING", "PROVIDER_RESULT_URL_INVALID",
  "PROVIDER_STATUS_INVALID", "PROVIDER_POLL_TIMEOUT", "RESULT_DOWNLOAD_HTTP_ERROR",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEMO_STORAGE_ERROR", "IMAGE_RESULT_PROCESSING_FAILED",
]);
const httpCodes = new Set(["PROVIDER_SUBMISSION_HTTP_ERROR", "PROVIDER_POLL_HTTP_ERROR", "RESULT_DOWNLOAD_HTTP_ERROR"]);

export function imageTaskFailureDetail(error: unknown, phase: ImageTaskFailurePhase): ImageTaskFailureDetail {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof value.code === "string" && safeCodes.has(value.code) ? value.code
    : value.name === "TimeoutError" ? "OPERATION_TIMEOUT"
      : value.name === "AbortError" ? "OPERATION_ABORTED" : "PROVIDER_OPERATION_FAILED";
  const httpStatus = httpCodes.has(code) && typeof value.httpStatus === "number"
    && Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599
    ? value.httpStatus : undefined;
  return { phase, code, ...(httpStatus === undefined ? {} : { httpStatus }) };
}

export function imageTaskPauseReason(phase: ImageTaskFailurePhase) {
  if (phase === "polling") return "原图片任务的状态查询暂时失败，已暂停；可恢复查询同一任务，不会重新生成或重复收费。";
  if (phase === "download") return "原图片任务已生成结果，但下载暂时失败；可恢复下载原结果，不会重新生成或重复收费。";
  if (phase === "result_store") return "原图片结果的本地保存暂时失败，已暂停；可恢复保存原结果，不会重新生成或重复收费。";
  return "图片提交状态尚未确认，已暂停；不会重新生成或自动退款。取得原上游任务 ID 后才能安全恢复。";
}

/** Private recovery data belongs only in the durable task store, never in an API response. */
export function imageTaskApiReplacer(key: string, value: unknown) {
  return key === "upstreamResultUrl" ? undefined : value;
}
