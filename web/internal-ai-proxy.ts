import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { Plugin } from "vite";

type InternalAiProxyOptions = {
    appKey?: string;
    seamlessUrl?: string;
    configPath: string;
    configToken?: string;
    mock?: boolean;
};

type InternalAiServerConfig = {
    appKey: string;
    seamlessUrl: string;
    updatedAt: string;
};

type UpstreamPayload = {
    success?: string;
    err_code?: string | number | null;
    err_msg?: string;
    error_code?: string | number | null;
    error_msg?: string;
    data?: unknown;
    error?: { message?: string };
};

const SEAMLESS_PROXY_PATH = "/api/internal-ai/seamless-stitch";
const CONFIG_PATH = "/api/internal-ai/config";
const CONFIG_TEST_PATH = "/api/internal-ai/config/test";
const DEFAULT_SEAMLESS_URL = "http://122.247.78.91:8101/std/tohwkdpj";
const MAX_REQUEST_BYTES = 30 * 1024 * 1024;
const TEST_IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6iXQAAAAASUVORK5CYII=";

export function internalAiProxyPlugin(options: InternalAiProxyOptions): Plugin {
    let persistedConfig = readServerConfig(options.configPath);

    const resolvedConfig = () => ({
        appKey: persistedConfig.appKey || options.appKey?.trim() || "",
        seamlessUrl: persistedConfig.seamlessUrl || options.seamlessUrl?.trim() || DEFAULT_SEAMLESS_URL,
        updatedAt: persistedConfig.updatedAt,
    });

    const handleSeamless = async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== "POST") {
            writeJson(response, 405, { error: { message: "仅支持 POST 请求" } });
            return;
        }

        try {
            const body = await readJsonBody(request);
            const image = typeof body.image === "string" ? body.image.replace(/\s+/g, "") : "";
            const mimeType = normalizeMimeType(body.mimeType);
            const rows = Number(body.rows);
            const cols = Number(body.cols);
            if (!image || !/^[A-Za-z0-9+/=]+$/.test(image)) throw new RequestError(400, "图片数据格式不正确");
            if (!isEvenMultiplier(rows) || !isEvenMultiplier(cols)) throw new RequestError(400, "横向和纵向倍率必须是 2 的倍数");

            if (options.mock) {
                await new Promise((resolve) => setTimeout(resolve, 900));
                writeJson(response, 200, { success: "OK", data: { list: [`data:${mimeType};base64,${image}`] } });
                return;
            }

            const config = resolvedConfig();
            const upstream = await callSeamlessApi(config, { image, rows, cols });
            const failed = upstream.payload.success && upstream.payload.success !== "OK";
            if (failed) {
                writeJson(response, 502, normalizeUpstreamFailure(upstream.payload));
                return;
            }
            writeJson(response, upstream.status, upstream.payload);
        } catch (error) {
            writeProxyError(response, error);
        }
    };

    const handleConfig = async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method === "GET") {
            writeJson(response, 200, publicConfig(resolvedConfig()));
            return;
        }
        if (request.method !== "POST" && request.method !== "PUT") {
            writeJson(response, 405, { error: { message: "仅支持 GET、POST 或 PUT 请求" } });
            return;
        }
        if (!canWriteConfig(request, options.configToken)) {
            writeJson(response, 403, { error: { message: "只有本机管理员可以修改内部 AI 配置" } });
            return;
        }

        try {
            const body = await readJsonBody(request);
            const current = resolvedConfig();
            const seamlessUrl = normalizeHttpUrl(body.seamlessUrl, current.seamlessUrl);
            const providedKey = typeof body.appKey === "string" ? body.appKey.trim() : "";
            const clearAppKey = body.clearAppKey === true;
            persistedConfig = {
                appKey: clearAppKey ? "" : providedKey || persistedConfig.appKey,
                seamlessUrl,
                updatedAt: new Date().toISOString(),
            };
            writeServerConfig(options.configPath, persistedConfig);
            writeJson(response, 200, publicConfig(resolvedConfig()));
        } catch (error) {
            writeProxyError(response, error);
        }
    };

    const handleConfigTest = async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method !== "POST") {
            writeJson(response, 405, { error: { message: "仅支持 POST 请求" } });
            return;
        }
        if (!canWriteConfig(request, options.configToken)) {
            writeJson(response, 403, { error: { message: "只有本机管理员可以测试内部 AI 配置" } });
            return;
        }

        try {
            const upstream = await callSeamlessApi(resolvedConfig(), { image: TEST_IMAGE_BASE64, rows: 2, cols: 2 });
            if (upstream.payload.success && upstream.payload.success !== "OK") {
                writeJson(response, 502, normalizeUpstreamFailure(upstream.payload));
                return;
            }
            writeJson(response, 200, { ok: true, message: "内部 AI 无缝拼接接口连接成功" });
        } catch (error) {
            writeProxyError(response, error);
        }
    };

    const install = (middlewares: { use: (path: string, handler: (request: IncomingMessage, response: ServerResponse) => void) => void }) => {
        middlewares.use(SEAMLESS_PROXY_PATH, (request, response) => void handleSeamless(request, response));
        middlewares.use(CONFIG_TEST_PATH, (request, response) => void handleConfigTest(request, response));
        middlewares.use(CONFIG_PATH, (request, response) => void handleConfig(request, response));
    };

    return {
        name: "internal-ai-proxy",
        configureServer(server) {
            install(server.middlewares);
        },
        configurePreviewServer(server) {
            install(server.middlewares);
        },
    };
}

async function callSeamlessApi(config: Pick<InternalAiServerConfig, "appKey" | "seamlessUrl">, input: { image: string; rows: number; cols: number }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
        const response = await fetch(config.seamlessUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ app_key: config.appKey, ...input }),
            signal: controller.signal,
        });
        return { status: response.ok ? 200 : response.status, payload: await readUpstreamPayload(response) };
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new RequestError(504, "内部 AI 接口请求超时");
        throw new RequestError(502, "无法连接内部 AI 服务，请检查接口地址和服务状态");
    } finally {
        clearTimeout(timeout);
    }
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
        if (size > MAX_REQUEST_BYTES) throw new RequestError(413, "上传图片过大，请压缩后重试");
        chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) throw new RequestError(400, "请求内容为空");
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        throw new RequestError(400, "请求内容不是有效 JSON");
    }
}

async function readUpstreamPayload(response: Response): Promise<UpstreamPayload> {
    const text = await response.text();
    if (!text) return response.ok ? { success: "OK", data: {} } : { error: { message: `内部 AI 接口返回 HTTP ${response.status}` } };
    try {
        return JSON.parse(text) as UpstreamPayload;
    } catch {
        return { error: { message: response.ok ? "内部 AI 接口返回格式不正确" : text.slice(0, 300) } };
    }
}

function normalizeUpstreamFailure(payload: UpstreamPayload): UpstreamPayload {
    const rawMessage = payload.err_msg || payload.error_msg || payload.error?.message || "内部 AI 接口执行失败";
    const message = /127\.0\.0\.1:10002|Connection refused/i.test(rawMessage) ? "内部 AI 无缝拼接工作节点未启动，请联系服务维护人员启动 10002 工作节点" : rawMessage;
    return { ...payload, err_msg: message, error_msg: message, error: { message } };
}

function publicConfig(config: InternalAiServerConfig) {
    return {
        seamlessUrl: config.seamlessUrl,
        hasAppKey: Boolean(config.appKey),
        appKeyPreview: previewSecret(config.appKey),
        updatedAt: config.updatedAt || null,
        protocol: "app-key-json" as const,
    };
}

function readServerConfig(path: string): InternalAiServerConfig {
    if (!existsSync(path)) return { appKey: "", seamlessUrl: "", updatedAt: "" };
    try {
        const value = JSON.parse(readFileSync(path, "utf8")) as Partial<InternalAiServerConfig>;
        return {
            appKey: typeof value.appKey === "string" ? value.appKey.trim() : "",
            seamlessUrl: typeof value.seamlessUrl === "string" ? value.seamlessUrl.trim() : "",
            updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
        };
    } catch {
        return { appKey: "", seamlessUrl: "", updatedAt: "" };
    }
}

function writeServerConfig(path: string, config: InternalAiServerConfig) {
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, path);
}

function canWriteConfig(request: IncomingMessage, configToken?: string) {
    const token = configToken?.trim();
    const authorization = String(request.headers.authorization || "");
    if (token && authorization === `Bearer ${token}`) return true;
    const remoteAddress = request.socket.remoteAddress || "";
    const isLoopback = remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
    return isLoopback && request.headers["x-admin-role"] === "admin";
}

function normalizeHttpUrl(value: unknown, fallback: string) {
    const url = typeof value === "string" ? value.trim() : fallback;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
        return parsed.toString().replace(/\/$/, "");
    } catch {
        throw new RequestError(400, "接口地址必须是有效的 HTTP 或 HTTPS URL");
    }
}

function previewSecret(value: string) {
    if (!value) return "";
    if (value.length <= 8) return `${value.slice(0, 2)}***${value.slice(-2)}`;
    return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function writeProxyError(response: ServerResponse, error: unknown) {
    if (error instanceof RequestError) {
        writeJson(response, error.status, { error: { message: error.message } });
        return;
    }
    writeJson(response, 500, { error: { message: error instanceof Error ? error.message : "内部 AI 请求失败" } });
}

function writeJson(response: ServerResponse, status: number, payload: unknown) {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
}

function normalizeMimeType(value: unknown) {
    return typeof value === "string" && /^image\/[a-z0-9.+-]+$/i.test(value) ? value : "image/png";
}

function isEvenMultiplier(value: number) {
    return Number.isInteger(value) && value >= 2 && value <= 32 && value % 2 === 0;
}

class RequestError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}
