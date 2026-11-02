import type { ErrorRequestHandler } from "express";

// Only configuration constraints with a known user-facing meaning belong here.
// Unknown database/audit failures must remain server errors, not client errors.
const constraintMessages: Record<string, { code: string; status: number; error: string; message: string }> = {
    providers_name_key: { code: "23505", status: 409, error: "DUPLICATE", message: "API 服务名称已存在" },
    model_configs_provider_id_model_id_key: { code: "23505", status: 409, error: "DUPLICATE", message: "该 API 服务下的模型标识已存在" },
    departments_name_key: { code: "23505", status: 409, error: "DUPLICATE", message: "部门名称已存在" },
    departments_code_key: { code: "23505", status: 409, error: "DUPLICATE", message: "部门编码已存在" },
    model_configs_provider_id_fkey: { code: "23503", status: 400, error: "PROVIDER_NOT_FOUND", message: "所选 API 服务不存在，请刷新后重新选择" },
    model_configs_workflow_config_id_fkey: { code: "23503", status: 400, error: "WORKFLOW_NOT_FOUND", message: "所选工作流不存在，请刷新后重新选择" },
    model_configs_replacement_model_config_id_fkey: { code: "23503", status: 400, error: "INVALID_MODEL_REPLACEMENT", message: "替代模型不存在，请刷新后重新选择" },
    tool_api_configurations_model_config_id_fkey: { code: "23503", status: 400, error: "MODEL_NOT_FOUND", message: "所选模型不存在，请刷新后重新选择" },
};

export const configurationErrorHandler: ErrorRequestHandler = (error, _request, response, next) => {
    const known = error && typeof error === "object" && typeof error.constraint === "string"
        ? constraintMessages[error.constraint] : undefined;
    if (!known || error.code !== known.code) { next(error); return; }
    response.status(known.status).json({ error: known.error, message: known.message });
};
