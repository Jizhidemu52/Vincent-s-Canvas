import type { ReferenceImage } from "@/types/image";

export type ImageOptionField = { key: string; label: string; type?: "number" | "boolean" | "json" | "image"; options?: string[]; min?: number; max?: number; step?: number; tip?: string };
type Profile = { kind: string; outputFormats?: string[]; backgrounds?: string[]; supportsOfficialFallback?: boolean; supportsGif?: boolean; supportsMarkup?: boolean; supportsComplexity?: boolean };
const boolean = (key: string, label: string, tip?: string): ImageOptionField => ({ key, label, type: "boolean", tip });
const number = (key: string, label: string, min: number, max: number, step = 1): ImageOptionField => ({ key, label, type: "number", min, max, step });
const moderation = boolean("nsfw_check", "提交前内容检查", "额外调用渠道内容检查，可能增加费用与耗时；不改变模型自身的安全规则。");
const fallback = boolean("official_fallback", "允许官方渠道回退", "由渠道决定回退方式，可能增加费用。");

/** Only documented fields for the selected adapter are exposed or submitted. */
function nativeImageOptionFields(profile: Profile): ImageOptionField[] {
    if (profile.kind === "mai-image") return [{ key: "resolution", label: "清晰度 / 分辨率", options: ["1k", "2k"] }, boolean("web_grounding", "联网参考", "默认关闭；开启后模型可使用联网信息辅助生成。")];
    if (profile.kind === "grok-image") return [{ key: "resolution", label: "清晰度 / 分辨率", options: ["1k", "2k"] }, moderation];
    if (profile.kind === "standard" || profile.kind === "quality-resolution") return profile.outputFormats?.length ? [
        ...(profile.kind === "quality-resolution" ? [{ key: "resolution", label: "清晰度 / 分辨率", options: ["1k", "2k", "4k"] }] : []),
        { key: "background", label: "背景", options: profile.backgrounds || ["auto", "opaque", "transparent"] },
        { key: "output_format", label: "输出格式", options: profile.outputFormats, tip: "保留渠道原件，并在需要时转换为所选格式。严格蒙版主图固定为无损 PNG，JPEG/WebP 另存下载副本。" },
        { ...number("output_compression", "输出压缩质量", 0, 100), tip: "仅 JPEG / WebP 生效；100 为最高质量，PNG 无损无需设置。" },
        ...(profile.kind === "quality-resolution" ? [{ key: "moderation", label: "内容审核强度", options: ["auto", "low"], tip: "留空使用渠道默认 low；auto 使用自动审核强度，不影响平台自身安全规则。" }] : []),
        ...(profile.supportsComplexity ? [{ key: "complexity", label: "规划强度", options: ["low", "medium", "high"], tip: "独立于图片质量，默认 high；局部小改动可选 low，复杂文字和版式可选 high。" }] : []),
        ...(profile.supportsMarkup ? [{ key: "markup_reference", label: "独立透明 PNG 标注层", type: "image" as const, tip: "上传与第一张参考图同尺寸的透明 PNG 图层，不要与原图合并。需要参考图，不能同时使用蒙版；标注层最多 50 MB。" }] : []),
        ...(profile.supportsGif ? [
            { ...number("frame_count", "GIF 帧数", 2, 16), tip: "仅 GIF 生效，默认 9 帧；每段动图按整张帧拼图计费。" },
            { key: "frame_duration_ms", label: "GIF 每帧时长（毫秒）", type: "number" as const, min: 20, step: 10, tip: "仅 GIF 生效，默认 200 毫秒；最小 20 毫秒，按 10 毫秒递增。" },
        ] : []),
    ] : [];
    if (profile.kind === "gpt") return [moderation, fallback];
    if (profile.kind === "gemini") return [moderation, ...(profile.supportsOfficialFallback === false ? [] : [fallback]), boolean("google_search", "Google 文本搜索"), boolean("google_image_search", "Google 图片搜索", "开启时同时启用文本搜索。")];
    if (profile.kind === "midjourney-blend") return [moderation, { key: "dimensions", label: "比例预设", options: ["SQUARE", "PORTRAIT", "LANDSCAPE"], tip: "上方尺寸优先；选择预设时同步尺寸。" }, { key: "metadata", label: "任务附加信息 JSON", type: "json" }];
    if (profile.kind !== "midjourney") return [];
    return [moderation,
        { key: "quality", label: "渲染质量 --q", options: ["0.25", "0.5", "1", "2"] },
        { key: "version", label: "版本 --v", tip: "留空使用渠道默认；版本会影响下列参数的支持范围。" },
        { key: "style", label: "风格 --style" }, number("seed", "随机种子", 0, 4294967295),
        { key: "negative_prompt", label: "排除内容 --no" }, number("stylize", "风格化 --s", 0, 1000), number("chaos", "变化程度 --c", 0, 100), number("weird", "奇异度 --w", 0, 3000),
        boolean("tile", "无缝平铺"), boolean("niji", "Niji 模式"), boolean("raw", "Raw 模式"), boolean("draft", "草稿模式（v7+）"), boolean("hd", "高清模式（v8.1/8.2）", "未指定版本时渠道可能自动选择 v8.1。"),
        number("iw", "图像权重 --iw", 0, 3, 0.1), number("cw", "角色权重 --cw", 0, 100), number("sw", "风格权重 --sw", 0, 1000),
        { key: "cref", label: "角色参考 URL" }, { key: "sref", label: "风格参考 URL" }, { key: "dref", label: "深度参考 URL" }, number("dw", "深度权重 --dw", 0, 100, 0.1),
        { ...number("stop", "提前停止 --stop", 10, 100), tip: "仅 v5–6.1 / Niji 5–6。" },
        { key: "extra", label: "其他原生参数", tip: "如 --xxx，直接追加到渠道提示词；仅使用目标版本支持的参数。" },
        { key: "metadata", label: "任务附加信息 JSON", type: "json" },
    ];
}

export function imageOptionFields(profile: Profile): ImageOptionField[] {
    const fields = nativeImageOptionFields(profile);
    if (["midjourney", "midjourney-blend"].includes(profile.kind)) return fields;
    return [...fields, { key: "negative_prompt", label: "排除内容", tip: "此模型没有原生排除参数；由服务端作为自然语言要求加入实际发送的提示词，不保证逐项排除。原提示词保持不变。" }];
}

export function readImageOptions(value?: string): Record<string, string> {
    if (!value) return {};
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== "string")) throw new Error("图像高级参数格式无效，请重新设置");
    return parsed;
}

/** Local upload metadata only. Provider URLs are produced from authorized source assets on the server. */
export function imageMarkupReference(value?: string): ReferenceImage | undefined {
    const raw = readImageOptions(value).markup_reference;
    if (!raw) return undefined;
    let reference: ReferenceImage;
    try { reference = JSON.parse(raw); } catch { throw new Error("标注层记录无效，请重新上传独立透明 PNG"); }
    if (!reference || typeof reference !== "object" || reference.type !== "image/png" || typeof reference.name !== "string"
        || typeof reference.id !== "string" || typeof reference.dataUrl !== "string"
        || !(reference.storageKey?.startsWith("image:") || reference.dataUrl.startsWith("data:image/png;base64,") || /^\/api\/assets\/[a-zA-Z0-9_-]+\/content$/.test(reference.dataUrl))) {
        throw new Error("标注层必须是已上传的独立透明 PNG，不能直接填写外部地址");
    }
    if (reference.bytes !== undefined && reference.bytes > 50 * 1024 * 1024) throw new Error("标注层不能超过 50 MB");
    return reference;
}

/** Remove controls unsupported by a newly selected model; keep valid explicit choices. */
export function normalizeImageOptions(value: string | undefined, profile: Profile) {
    const original = readImageOptions(value);
    const normalized: Record<string, string> = {};
    const fields = imageOptionFields(profile);
    for (const [key, raw] of Object.entries(original)) {
        const field = fields.find(field => field.key === key);
        if (!field) continue;
        if (field.options && raw && !field.options.includes(raw)) {
            if (key === "resolution") normalized[key] = field.options[0]!;
            continue;
        }
        if (field.type === "boolean" && raw && !["true", "false"].includes(raw)) continue;
        normalized[field.key] = raw;
    }
    const resolution = fields.find(field => field.key === "resolution");
    if (resolution && !normalized.resolution) normalized.resolution = resolution.options![0]!;
    return JSON.stringify(normalized);
}

export function imageAdvancedParameters(value: string | undefined, profile: Profile): Record<string, unknown> {
    const options = readImageOptions(value);
    const parameters: Record<string, unknown> = {};
    for (const field of imageOptionFields(profile)) {
        const raw = options[field.key]?.trim();
        if (!raw) continue;
        if (field.type === "image") { imageMarkupReference(value); continue; }
        if (field.key === "resolution" && profile.supportsGif && options.output_format === "gif") continue;
        if (["frame_count", "frame_duration_ms"].includes(field.key) && options.output_format !== "gif") continue;
        if (field.key === "output_compression" && !["jpeg", "webp"].includes(options.output_format || "png")) continue;
        const key = profile.kind === "midjourney" && field.key === "quality" ? "midjourneyQuality" : field.key;
        if (field.options && !field.options.includes(raw)) throw new Error(`${field.label}不支持 ${raw}`);
        if (field.type === "number") {
            const value = Number(raw);
            if (!Number.isFinite(value) || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max) || (field.step === 1 && !Number.isInteger(value))) throw new Error(`${field.label}必须为 ${field.min}${field.max === undefined ? " 以上" : `–${field.max} 范围内`}的${field.step === 1 ? "整数" : "数值"}`);
            if (field.key === "frame_duration_ms" && (!Number.isInteger(value) || value % 10)) throw new Error("GIF 每帧时长必须为不少于 20 的整数毫秒，且为 10 的倍数");
            parameters[key] = value;
        } else if (field.type === "boolean") {
            if (!["true", "false"].includes(raw)) throw new Error(`${field.label}必须为开或关`);
            parameters[key] = raw === "true";
        } else if (field.type === "json") {
            let object: unknown;
            try { object = JSON.parse(raw); } catch { throw new Error(`${field.label}不是有效 JSON`); }
            if (!object || typeof object !== "object" || Array.isArray(object)) throw new Error(`${field.label}必须为 JSON 对象`);
            parameters[key] = object;
        } else parameters[key] = raw;
    }
    if (parameters.google_image_search === true) parameters.google_search = true;
    return parameters;
}
