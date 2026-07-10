import axios from "axios";
import { nanoid } from "nanoid";

import { imageToDataUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

type InternalAiPayload = {
    success?: string;
    err_code?: string | number | null;
    err_msg?: string;
    error_code?: string | number;
    error_msg?: string;
    data?: unknown;
    error?: { message?: string };
};

export async function requestSeamlessStitch(reference: ReferenceImage, rows: number, cols: number) {
    if (!isEvenMultiplier(rows) || !isEvenMultiplier(cols)) throw new Error("横向和纵向倍率必须是 2 的倍数");
    const dataUrl = await imageToDataUrl(reference);
    const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is);
    if (!match) throw new Error("输入图片无法转换为 Base64");

    try {
        const response = await axios.post<InternalAiPayload>("/api/internal-ai/seamless-stitch", {
            image: match[2],
            mimeType: match[1],
            rows,
            cols,
        });
        if (response.data.success && response.data.success !== "OK") throw new Error(response.data.err_msg || response.data.error_msg || `接口返回 ${response.data.success}`);
        const resultUrl = extractImageResult(response.data.data);
        if (!resultUrl) throw new Error("内部 AI 接口成功，但没有返回可显示的图片");
        return { id: nanoid(), dataUrl: resultUrl };
    } catch (error) {
        if (error instanceof Error && !axios.isAxiosError(error)) throw error;
        if (axios.isAxiosError<InternalAiPayload>(error)) {
            const payload = error.response?.data;
            throw new Error(payload?.error?.message || payload?.err_msg || payload?.error_msg || error.message || "无缝拼接请求失败");
        }
        throw new Error("无缝拼接请求失败");
    }
}

function extractImageResult(value: unknown, depth = 0): string | null {
    if (depth > 6 || value == null) return null;
    if (typeof value === "string") {
        const normalized = value.trim();
        if (/^(data:image\/|https?:\/\/|blob:)/i.test(normalized)) return normalized;
        if (normalized.length > 100 && /^[A-Za-z0-9+/=]+$/.test(normalized)) return `data:image/png;base64,${normalized}`;
        return null;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const result = extractImageResult(item, depth + 1);
            if (result) return result;
        }
        return null;
    }
    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        const priorityKeys = ["list", "image", "image_url", "url", "base64", "result", "data"];
        for (const key of priorityKeys) {
            if (!(key in record)) continue;
            const result = extractImageResult(record[key], depth + 1);
            if (result) return result;
        }
        for (const item of Object.values(record)) {
            const result = extractImageResult(item, depth + 1);
            if (result) return result;
        }
    }
    return null;
}

function isEvenMultiplier(value: number) {
    return Number.isInteger(value) && value >= 2 && value <= 32 && value % 2 === 0;
}
