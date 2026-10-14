export type ImageOptionField = { key: string; label: string; type?: "number" | "boolean" | "json"; options?: string[]; min?: number; max?: number; step?: number; tip?: string };
type Profile = { kind: string; outputFormats?: string[]; backgrounds?: string[] };
const boolean = (key: string, label: string, tip?: string): ImageOptionField => ({ key, label, type: "boolean", tip });
const number = (key: string, label: string, min: number, max: number, step = 1): ImageOptionField => ({ key, label, type: "number", min, max, step });
const moderation = boolean("nsfw_check", "提交前内容检查", "额外调用渠道内容检查，可能增加费用与耗时；不改变模型自身的安全规则。");
const fallback = boolean("official_fallback", "允许官方渠道回退", "由渠道决定回退方式，可能增加费用。");

/** Only documented fields for the selected adapter are exposed or submitted. */
export function imageOptionFields(profile: Profile): ImageOptionField[] {
    if (profile.kind === "standard") return profile.outputFormats?.length ? [
        { key: "background", label: "背景", options: profile.backgrounds || ["auto", "opaque", "transparent"] },
        { key: "output_format", label: "输出格式", options: profile.outputFormats, tip: "保留渠道原件，并在需要时转换为所选格式。严格蒙版主图固定为无损 PNG，JPEG/WebP 另存下载副本。" },
        { ...number("output_compression", "输出压缩质量", 0, 100), tip: "仅 JPEG / WebP 生效；100 为最高质量，PNG 无损无需设置。" },
    ] : [];
    if (profile.kind === "gpt") return [moderation, fallback];
    if (profile.kind === "gemini") return [moderation, fallback, boolean("google_search", "Google 文本搜索"), boolean("google_image_search", "Google 图片搜索", "开启时同时启用文本搜索。")];
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
        { ...number("repeat", "重复生成 --repeat", 2, 40), tip: "会额外生成并计费，不等同于工作台批量张数。" },
        { ...number("stop", "提前停止 --stop", 10, 100), tip: "仅 v5–6.1 / Niji 5–6。" },
        { key: "extra", label: "其他原生参数", tip: "如 --xxx，直接追加到渠道提示词；仅使用目标版本支持的参数。" },
        { key: "metadata", label: "任务附加信息 JSON", type: "json" },
    ];
}

export function readImageOptions(value?: string): Record<string, string> {
    if (!value) return {};
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== "string")) throw new Error("图像高级参数格式无效，请重新设置");
    return parsed;
}

export function imageAdvancedParameters(value: string | undefined, profile: Profile): Record<string, unknown> {
    const options = readImageOptions(value);
    const parameters: Record<string, unknown> = {};
    for (const field of imageOptionFields(profile)) {
        const raw = options[field.key]?.trim();
        if (!raw) continue;
        if (field.key === "output_compression" && !["jpeg", "webp"].includes(options.output_format || "png")) continue;
        const key = profile.kind === "midjourney" && field.key === "quality" ? "midjourneyQuality" : field.key;
        if (field.options && !field.options.includes(raw)) throw new Error(`${field.label}不支持 ${raw}`);
        if (field.type === "number") {
            const value = Number(raw);
            if (!Number.isFinite(value) || value < field.min! || value > field.max! || (field.step === 1 && !Number.isInteger(value))) throw new Error(`${field.label}必须为 ${field.min}–${field.max} 范围内的${field.step === 1 ? "整数" : "数值"}`);
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
