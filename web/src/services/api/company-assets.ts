import axios from "axios";

import type { Asset } from "@/stores/use-asset-store";
import type { LocalUser } from "@/stores/use-user-store";

export type CompanyAssetDatabaseStatus = {
    baseUrl: string;
    uploadPath: string;
    queryPath: string;
    healthPath: string;
    enabled: boolean;
    hasApiToken: boolean;
    apiTokenPreview: string;
    updatedAt: string | null;
};

export type CompanyAssetDatabaseInput = Pick<CompanyAssetDatabaseStatus, "baseUrl" | "uploadPath" | "queryPath" | "healthPath" | "enabled"> & {
    apiToken?: string;
    clearApiToken?: boolean;
};

const adminHeaders = { "x-admin-role": "admin" };

export async function getCompanyAssetDatabaseConfig() {
    try {
        const response = await axios.get<CompanyAssetDatabaseStatus>("/api/company-assets/config", { headers: adminHeaders });
        return response.data;
    } catch (error) {
        throw new Error(apiErrorMessage(error, "公司素材数据库配置读取失败"));
    }
}

export async function saveCompanyAssetDatabaseConfig(input: CompanyAssetDatabaseInput) {
    try {
        const response = await axios.put<CompanyAssetDatabaseStatus>("/api/company-assets/config", input, { headers: adminHeaders });
        return response.data;
    } catch (error) {
        throw new Error(apiErrorMessage(error, "公司素材数据库配置保存失败"));
    }
}

export async function testCompanyAssetDatabaseConfig() {
    try {
        const response = await axios.post<{ ok: boolean; message: string }>("/api/company-assets/config/test", {}, { headers: adminHeaders });
        return response.data;
    } catch (error) {
        throw new Error(apiErrorMessage(error, "公司素材数据库连接测试失败"));
    }
}

export async function syncAssetToCompanyDatabase(asset: Asset, user: LocalUser) {
    const payload = {
        id: asset.id,
        ownerId: asset.ownerId,
        ownerName: user.displayName,
        kind: asset.kind,
        title: asset.title,
        tags: asset.tags,
        source: asset.source || "",
        note: asset.note || "",
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt,
        metadata: asset.metadata || {},
        content: await serializeAssetContent(asset),
    };

    try {
        const response = await axios.post("/api/company-assets/assets", payload, {
            headers: { "x-user-id": user.id, "x-user-role": user.role },
            maxBodyLength: 40 * 1024 * 1024,
        });
        if (response.data?.synced === false) return { synced: false as const, skipped: true as const };
        return { synced: true as const, remote: response.data };
    } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 503) return { synced: false as const, skipped: true as const };
        throw new Error(apiErrorMessage(error, "素材同步到公司数据库失败"));
    }
}

async function serializeAssetContent(asset: Asset) {
    if (asset.kind === "text") return { text: asset.data.content };
    const url = asset.kind === "image" ? asset.data.dataUrl : asset.data.url;
    return {
        mediaUrl: url,
        storageKey: asset.data.storageKey || "",
        width: asset.data.width,
        height: asset.data.height,
        bytes: asset.data.bytes,
        mimeType: asset.data.mimeType,
        contentBase64: await mediaUrlToBase64(url),
    };
}

async function mediaUrlToBase64(url: string) {
    if (!url) return "";
    const dataUrlMatch = url.match(/^data:[^;]+;base64,(.+)$/);
    if (dataUrlMatch) return dataUrlMatch[1];
    if (!url.startsWith("blob:")) return "";
    try {
        const blob = await fetch(url).then((response) => response.blob());
        return await blobToBase64(blob);
    } catch {
        return "";
    }
}

function blobToBase64(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || "").replace(/^data:[^;]+;base64,/, ""));
        reader.onerror = () => reject(new Error("读取素材内容失败"));
        reader.readAsDataURL(blob);
    });
}

function apiErrorMessage(error: unknown, fallback: string) {
    if (!axios.isAxiosError(error)) return error instanceof Error ? error.message : fallback;
    const payload = error.response?.data as { error?: { message?: string }; message?: string } | undefined;
    return payload?.error?.message || payload?.message || fallback;
}
