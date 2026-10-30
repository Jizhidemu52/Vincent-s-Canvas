import { uiText, useUiText } from "@/lib/i18n";

const fieldLabels: Record<string, string> = {
    description: "具体要求", category: "品类", silhouette: "廓形", fabric: "面料", presentation: "展示方式", sketchStyle: "线稿风格", sketchDetail: "细节程度",
    restyleArea: "修改部位", change: "修改要求", preserve: "保留内容", colorMode: "配色方式", colors: "目标颜色", colorSelections: "标准色", colorRegion: "配色区域", colorMood: "配色方向",
    backStructure: "背面结构", backMotif: "背面图案", extractMode: "提取方式", extractBackground: "背景", craft: "工艺", craftFabric: "工艺面料", accessoryType: "辅料类型", accessoryApply: "应用方式",
    kind: "配方类型", series: "系列名称", constraints: "保持不变", prompt: "设计要求", count: "数量", palette: "色板", paletteStyle: "配色风格", positions: "图案位置", variantIndex: "候选序号", hasMotif: "使用图案参考",
};
const valueLabels: Record<string, string> = { smart: "智能配色", specific: "指定颜色", reference: "参考图配色", technical: "技术线稿", fashion: "时装插画", standard: "标准", detailed: "精细", structure: "保持结构的配色系列", pattern: "图案布局系列", soft: "柔和", vivid: "鲜明", earth: "自然大地色", free: "自由" };
const enumFields = new Set(["colorMode", "sketchStyle", "sketchDetail", "kind", "paletteStyle"]);
export function designInputValue(value: unknown, key?: string): string {
    if (value === null || value === undefined || value === "") return uiText("未填写");
    if (typeof value === "boolean") return uiText(value ? "是" : "否");
    if (Array.isArray(value)) return value.filter(item => item !== null).map(item => designInputValue(item, key)).join("；") || uiText("未填写");
    if (typeof value === "object") {
        const item = value as Record<string, unknown>;
        return [item.library, item.code, item.name, item.hex].filter(Boolean).map(String).join(" · ") || uiText("已设置");
    }
    return key && enumFields.has(key) && valueLabels[String(value)] ? uiText(valueLabels[String(value)]) : String(value);
}

export function GenerationInputList({ fields = {} }: { fields?: Record<string, unknown> }) {
    useUiText();
    return <dl className="my-3 grid gap-2 text-xs leading-6" aria-label={uiText("设计输入清单")}>
        {Object.entries(fields).map(([key, value]) => <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2" key={key}>
            <dt className="text-muted-foreground">{uiText(fieldLabels[key] || "补充信息")}</dt>
            <dd className="m-0 whitespace-pre-wrap break-words">{designInputValue(key === "variantIndex" && typeof value === "number" ? value + 1 : value, key)}</dd>
        </div>)}
    </dl>;
}
