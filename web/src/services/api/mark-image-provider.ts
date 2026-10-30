import type { ApimartImageCost } from "../../../../shared/apimart-image-costs";

export type MarkPlatformProvider = {
    id: string;
    name: string;
    protocol: "apimart";
    baseUrl: string;
    enabled: boolean;
    hasCredentials: boolean;
};

export type MarkPlatformModel = {
    id: string;
    modelId: string;
    name: string;
    enabled: boolean;
    creditCost: number;
    rmbCost: number;
    imageCost?: ApimartImageCost;
    concurrencyLimit: number;
};

export type MarkPlatformConfiguration = { provider: MarkPlatformProvider | null; models: MarkPlatformModel[] };
export type MarkPlatformConfigurationInput = {
    baseUrl: string;
    apiKey?: string;
    enabled: boolean;
    models: Array<Pick<MarkPlatformModel, "modelId" | "enabled" | "creditCost" | "rmbCost" | "concurrencyLimit">>;
};

// Keep the established imports and endpoint stable while the Mark channel includes all media types.
export type MarkImageProvider = MarkPlatformProvider;
export type MarkImageModel = MarkPlatformModel;
export type MarkImageConfiguration = MarkPlatformConfiguration;
export type MarkImageConfigurationInput = MarkPlatformConfigurationInput;

export class MarkImageConfigurationError extends Error {}

async function request(init?: RequestInit): Promise<MarkImageConfiguration> {
    try {
        const response = await fetch("/api/admin/model-configuration/mark-images", {
            ...init,
            credentials: "include",
            cache: "no-store",
            headers: { "content-type": "application/json" },
        });
        if (!response.ok) {
            // Do not display arbitrary response bodies: upstream or proxy errors can contain credentials.
            const reason = response.status === 401 ? "登录已过期，请重新登录管理员账号。"
                : response.status === 403 ? "仅超级管理员可配置 Mark 平台。"
                : [404, 405, 501].includes(response.status) ? "当前服务不支持 Mark 平台配置，请使用正式业务服务（非演示服务）。"
                : response.status === 400 ? "配置未保存，请检查接口地址、API Key 和模型参数；首次保存必须填写 API Key。"
                : "Mark 平台配置服务暂不可用，请稍后重试。";
            throw new MarkImageConfigurationError(reason);
        }
        return await response.json() as MarkImageConfiguration;
    } catch (error) {
        if (error instanceof MarkImageConfigurationError) throw error;
        throw new MarkImageConfigurationError("无法读取或保存 Mark 平台配置，请检查网络后重试。");
    }
}

export const getMarkImageConfiguration = () => request();
export const saveMarkImageConfiguration = (input: MarkImageConfigurationInput) => request({
    method: "PUT",
    body: JSON.stringify({ ...input, apiKey: input.apiKey?.trim() || undefined }),
});
