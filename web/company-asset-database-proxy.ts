import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { Plugin } from "vite";

type CompanyAssetDatabaseOptions = {
    configPath: string;
    baseUrl?: string;
    apiToken?: string;
    configToken?: string;
};

type CompanyAssetDatabaseConfig = {
    baseUrl: string;
    uploadPath: string;
    queryPath: string;
    healthPath: string;
    apiToken: string;
    enabled: boolean;
    updatedAt: string;
};

const CONFIG_PATH = "/api/company-assets/config";
const CONFIG_TEST_PATH = "/api/company-assets/config/test";
const ASSET_PATH = "/api/company-assets/assets";
const MAX_REQUEST_BYTES = 40 * 1024 * 1024;

export function companyAssetDatabaseProxyPlugin(options: CompanyAssetDatabaseOptions): Plugin {
    let persisted = readConfig(options.configPath);

    const resolvedConfig = (): CompanyAssetDatabaseConfig => ({
        baseUrl: persisted.baseUrl || options.baseUrl?.trim() || "",
        uploadPath: persisted.uploadPath || "/api/assets",
        queryPath: persisted.queryPath || "/api/assets",
        healthPath: persisted.healthPath || "/health",
        apiToken: persisted.apiToken || options.apiToken?.trim() || "",
        enabled: persisted.enabled,
        updatedAt: persisted.updatedAt,
    });

    const handleConfig = async (request: IncomingMessage, response: ServerResponse) => {
        if (!canManageConfig(request, options.configToken)) return writeJson(response, 403, { error: { message: "只有管理员可以查看或修改公司素材数据库配置" } });
        if (request.method === "GET") return writeJson(response, 200, publicConfig(resolvedConfig()));
        if (request.method !== "POST" && request.method !== "PUT") return writeJson(response, 405, { error: { message: "仅支持 GET、POST 或 PUT 请求" } });

        try {
            const body = await readJsonBody(request);
            const current = resolvedConfig();
            const baseUrl = normalizeBaseUrl(body.baseUrl, current.baseUrl, body.enabled === true);
            const providedToken = typeof body.apiToken === "string" ? body.apiToken.trim() : "";
            persisted = {
                baseUrl,
                uploadPath: normalizePath(body.uploadPath, current.uploadPath),
                queryPath: normalizePath(body.queryPath, current.queryPath),
                healthPath: normalizePath(body.healthPath, current.healthPath),
                apiToken: body.clearApiToken === true ? "" : providedToken || persisted.apiToken,
                enabled: body.enabled === true,
                updatedAt: new Date().toISOString(),
            };
            writeConfig(options.configPath, persisted);
            writeJson(response, 200, publicConfig(resolvedConfig()));
        } catch (error) {
            writeError(response, error);
        }
    };

    const handleTest = async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== "POST") return writeJson(response, 405, { error: { message: "仅支持 POST 请求" } });
        if (!canManageConfig(request, options.configToken)) return writeJson(response, 403, { error: { message: "只有管理员可以测试公司素材数据库" } });
        const config = resolvedConfig();
        if (!config.enabled || !config.baseUrl) return writeJson(response, 400, { error: { message: "请先填写数据库服务地址并启用同步" } });

        try {
            const upstream = await callUpstream(config, config.healthPath, { method: "GET" });
            if (!upstream.ok) throw new RequestError(502, `公司素材数据库健康检查失败：HTTP ${upstream.status}`);
            writeJson(response, 200, { ok: true, message: "公司素材数据库连接成功" });
        } catch (error) {
            writeError(response, error);
        }
    };

    const handleAssets = async (request: IncomingMessage, response: ServerResponse) => {
        const userId = String(request.headers["x-user-id"] || "").trim();
        const role = request.headers["x-user-role"] === "admin" ? "admin" : "designer";
        if (!userId) return writeJson(response, 401, { error: { message: "缺少登录用户身份" } });
        const config = resolvedConfig();
        if (!config.enabled || !config.baseUrl) {
            if (request.method === "POST") {
                try {
                    await readJsonBody(request);
                    return writeJson(response, 202, { synced: false, skipped: true, message: "公司素材数据库同步未启用，素材已保留在本机" });
                } catch (error) {
                    return writeError(response, error);
                }
            }
            return writeJson(response, 503, { error: { message: "管理员尚未启用公司素材数据库同步" } });
        }

        try {
            if (request.method === "POST") {
                const body = await readJsonBody(request);
                const ownerId = typeof body.ownerId === "string" ? body.ownerId.trim() : "";
                if (!ownerId) throw new RequestError(400, "素材必须包含 ownerId");
                if (role !== "admin" && ownerId !== userId) throw new RequestError(403, "设计师只能保存自己的素材");
                const upstream = await callUpstream(config, config.uploadPath, { method: "POST", body: JSON.stringify(body) });
                return pipeUpstream(response, upstream);
            }
            if (request.method === "GET") {
                const requestUrl = new URL(request.url || "/", "http://localhost");
                const requestedOwner = requestUrl.searchParams.get("ownerId")?.trim() || "";
                const ownerId = role === "admin" ? requestedOwner : userId;
                const query = ownerId ? `?ownerId=${encodeURIComponent(ownerId)}` : "";
                const upstream = await callUpstream(config, `${config.queryPath}${query}`, { method: "GET" });
                return pipeUpstream(response, upstream);
            }
            writeJson(response, 405, { error: { message: "仅支持 GET 或 POST 请求" } });
        } catch (error) {
            writeError(response, error);
        }
    };

    const install = (middlewares: { use: (path: string, handler: (request: IncomingMessage, response: ServerResponse) => void) => void }) => {
        middlewares.use(CONFIG_TEST_PATH, (request, response) => void handleTest(request, response));
        middlewares.use(CONFIG_PATH, (request, response) => void handleConfig(request, response));
        middlewares.use(ASSET_PATH, (request, response) => void handleAssets(request, response));
    };

    return {
        name: "company-asset-database-proxy",
        configureServer(server) {
            install(server.middlewares);
        },
        configurePreviewServer(server) {
            install(server.middlewares);
        },
    };
}

async function callUpstream(config: CompanyAssetDatabaseConfig, path: string, init: RequestInit) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        return await fetch(`${config.baseUrl}${path}`, {
            ...init,
            headers: {
                Accept: "application/json",
                ...(init.body ? { "Content-Type": "application/json" } : {}),
                ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken}` } : {}),
            },
            signal: controller.signal,
        });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new RequestError(504, "公司素材数据库请求超时");
        throw new RequestError(502, "无法连接公司素材数据库，请检查服务地址和网络");
    } finally {
        clearTimeout(timeout);
    }
}

async function pipeUpstream(response: ServerResponse, upstream: Response) {
    const text = await upstream.text();
    response.statusCode = upstream.status;
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
    response.end(text || JSON.stringify({ ok: upstream.ok }));
}

async function readJsonBody(request: IncomingMessage) {
    if (
        !String(request.headers["content-type"] || "")
            .toLowerCase()
            .includes("application/json")
    )
        throw new RequestError(415, "请求必须使用 application/json");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_REQUEST_BYTES) throw new RequestError(413, "素材数据超过 40MB，请改用对象存储直传方案");
        chunks.push(buffer);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } catch {
        throw new RequestError(400, "请求内容不是有效 JSON");
    }
}

function readConfig(path: string): CompanyAssetDatabaseConfig {
    const empty = { baseUrl: "", uploadPath: "/api/assets", queryPath: "/api/assets", healthPath: "/health", apiToken: "", enabled: false, updatedAt: "" };
    if (!existsSync(path)) return empty;
    try {
        const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CompanyAssetDatabaseConfig>;
        return {
            baseUrl: typeof value.baseUrl === "string" ? value.baseUrl.trim() : "",
            uploadPath: normalizePath(value.uploadPath, empty.uploadPath),
            queryPath: normalizePath(value.queryPath, empty.queryPath),
            healthPath: normalizePath(value.healthPath, empty.healthPath),
            apiToken: typeof value.apiToken === "string" ? value.apiToken.trim() : "",
            enabled: value.enabled === true,
            updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
        };
    } catch {
        return empty;
    }
}

function writeConfig(path: string, config: CompanyAssetDatabaseConfig) {
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, path);
}

function publicConfig(config: CompanyAssetDatabaseConfig) {
    return {
        baseUrl: config.baseUrl,
        uploadPath: config.uploadPath,
        queryPath: config.queryPath,
        healthPath: config.healthPath,
        enabled: config.enabled,
        hasApiToken: Boolean(config.apiToken),
        apiTokenPreview: previewSecret(config.apiToken),
        updatedAt: config.updatedAt || null,
    };
}

function canManageConfig(request: IncomingMessage, configToken?: string) {
    const authorization = String(request.headers.authorization || "");
    if (configToken?.trim() && authorization === `Bearer ${configToken.trim()}`) return true;
    const remoteAddress = request.socket.remoteAddress || "";
    const loopback = remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
    return loopback && request.headers["x-admin-role"] === "admin";
}

function normalizeBaseUrl(value: unknown, fallback: string, required: boolean) {
    const url = typeof value === "string" ? value.trim() : fallback;
    if (!url && !required) return "";
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
        return parsed.toString().replace(/\/$/, "");
    } catch {
        throw new RequestError(400, "数据库服务地址必须是有效的 HTTP 或 HTTPS URL");
    }
}

function normalizePath(value: unknown, fallback: string) {
    const path = typeof value === "string" && value.trim() ? value.trim() : fallback;
    return path.startsWith("/") ? path : `/${path}`;
}

function previewSecret(value: string) {
    if (!value) return "";
    return value.length <= 8 ? `${value.slice(0, 2)}***${value.slice(-2)}` : `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function writeError(response: ServerResponse, error: unknown) {
    const status = error instanceof RequestError ? error.status : 500;
    const message = error instanceof Error ? error.message : "公司素材数据库请求失败";
    writeJson(response, status, { error: { message } });
}

function writeJson(response: ServerResponse, status: number, payload: unknown) {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
}

class RequestError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}
