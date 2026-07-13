export const moduleKeys = [
    "detail-enhance", "image-edit", "angle-control", "seamless-stitch", "image",
    "video", "prompts", "assets", "gpt-chat", "canvas", "team",
] as const;

export type ModuleKey = (typeof moduleKeys)[number];
export type ModuleFlag = { moduleKey: ModuleKey; enabled: boolean; updatedAt: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
        ...init,
        credentials: "include",
        headers: { "content-type": "application/json", ...init?.headers },
    });
    if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message || "模块状态读取失败");
    }
    return response.json() as Promise<T>;
}

export const listModuleFlags = () => request<{ modules: ModuleFlag[] }>("/api/modules");

export const updateModuleFlag = (moduleKey: ModuleKey, enabled: boolean) =>
    request<{ module: ModuleFlag }>("/api/admin/modules", {
        method: "PATCH",
        body: JSON.stringify({ moduleKey, enabled }),
    });
