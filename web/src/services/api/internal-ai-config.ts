import axios from "axios";

export type InternalAiConfigStatus = {
    seamlessUrl: string;
    hasAppKey: boolean;
    appKeyPreview: string;
    updatedAt: string | null;
    protocol: "app-key-json";
};

type ApiErrorPayload = {
    error?: { message?: string };
    error_msg?: string;
    err_msg?: string;
};

const adminHeaders = { "x-admin-role": "admin" };

export async function getInternalAiConfig() {
    const response = await axios.get<InternalAiConfigStatus>("/api/internal-ai/config");
    return response.data;
}

export async function saveInternalAiConfig(input: { seamlessUrl: string; appKey?: string; clearAppKey?: boolean }) {
    try {
        const response = await axios.put<InternalAiConfigStatus>("/api/internal-ai/config", input, { headers: adminHeaders });
        return response.data;
    } catch (error) {
        throw new Error(readApiError(error, "内部 AI 配置保存失败"));
    }
}

export async function testInternalAiConfig() {
    try {
        const response = await axios.post<{ ok: boolean; message: string }>("/api/internal-ai/config/test", {}, { headers: adminHeaders });
        return response.data;
    } catch (error) {
        throw new Error(readApiError(error, "内部 AI 连接测试失败"));
    }
}

function readApiError(error: unknown, fallback: string) {
    if (!axios.isAxiosError<ApiErrorPayload>(error)) return error instanceof Error ? error.message : fallback;
    return error.response?.data?.error?.message || error.response?.data?.error_msg || error.response?.data?.err_msg || error.message || fallback;
}
