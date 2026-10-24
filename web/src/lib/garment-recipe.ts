import type { ReferenceImage } from "@/types/image";

export type GarmentScenario = "colorway" | "restyle";

export type GarmentBrief = {
    scenario: GarmentScenario;
    primaryId: string;
    target: string;
    preserve: string;
};

export type GarmentRecipe = {
    title: string;
    prompt: string;
    promptInput: import("../../../shared/prompt-contracts").PromptInputData;
    references: ReferenceImage[];
};

export const GARMENT_BRIEF_TEXT_LIMIT = 2000;

export const garmentScenarios: Array<{
    id: GarmentScenario;
    title: string;
    description: string;
    targetLabel: string;
    targetPlaceholder: string;
    limitation: string;
}> = [
    {
        id: "colorway",
        title: "服装换色",
        description: "保留服装结构与材质，探索指定部位的新配色。",
        targetLabel: "目标配色与部位",
        targetPlaceholder: "例如：衣身改成浅雾蓝，领口与袖口保留奶白色",
        limitation: "仅为概念配色效果，不保证精确色值、色号还原或实物色差。",
    },
    {
        id: "restyle",
        title: "服装改款",
        description: "按具体目标调整领型、袖型、长度或装饰等设计。",
        targetLabel: "改款目标",
        targetPlaceholder: "例如：圆领改为小翻领，袖口增加细褶，其余结构保留",
        limitation: "仅为改款概念效果，不是纸样、工艺单或可生产性保证。",
    },
];

function briefText(value: string, label: string, required = false) {
    if (typeof value !== "string") throw new Error(`${label}格式不正确，请重新填写`);
    const text = value.trim();
    if (required && !text) throw new Error(`请填写${label}`);
    if (text.length > GARMENT_BRIEF_TEXT_LIMIT) throw new Error(`${label}不能超过 ${GARMENT_BRIEF_TEXT_LIMIT} 个字符，请精简后重试`);
    return text;
}

/** Applied instructions depend on the exact ordered image sources, not display metadata. */
export function garmentReferencesMatch(expected: readonly ReferenceImage[], current: readonly ReferenceImage[]): boolean {
    if (expected.length !== current.length) return false;
    return expected.every((reference, index) => {
        const actual = current[index]!;
        return reference.id === actual.id
            && (reference.dataUrl || "") === (actual.dataUrl || "")
            && (reference.url || "") === (actual.url || "")
            && (reference.storageKey || "") === (actual.storageKey || "")
            && (reference.sourceAssetId || "") === (actual.sourceAssetId || "");
    });
}

/** Bind the garment by a stable ID, never by tray position or a previous selection. */
export function buildGarmentRecipe(brief: GarmentBrief, references: ReferenceImage[]): GarmentRecipe {
    const scenario = garmentScenarios.find(item => item.id === brief?.scenario);
    if (!scenario) throw new Error("请选择有效的服装换色或改款场景");
    const target = briefText(brief.target, scenario.targetLabel, true);
    const preserve = briefText(brief.preserve, "保留要求");
    if (!Array.isArray(references) || !references.length) throw new Error("请先添加服装主图");
    const referencesById = new Map<string, ReferenceImage>();
    for (const reference of references) {
        if (!reference || typeof reference.id !== "string" || !reference.id.trim()) throw new Error("参考图缺少有效 ID，请重新添加图片");
        if (referencesById.has(reference.id)) throw new Error("参考图 ID 重复，请重新添加图片");
        referencesById.set(reference.id, reference);
    }
    if (typeof brief.primaryId !== "string" || !brief.primaryId.trim()) throw new Error("请选择服装主图");
    const primary = referencesById.get(brief.primaryId);
    if (!primary) throw new Error("已绑定的服装主图已移除或不存在，请重新选择");
    const source = primary.dataUrl?.trim() || primary.url?.trim();
    if (!primary.storageKey?.trim() && !source) throw new Error("服装主图没有可用图片内容，请重新添加");
    if (primary.type && !primary.type.startsWith("image/")) throw new Error("服装主图不是图片，请重新添加");
    if (!primary.storageKey?.trim() && source?.startsWith("data:") && !/^data:image\/[^,]+,\S+$/i.test(source)) {
        throw new Error("服装主图图片内容无效，请重新添加");
    }

    return {
        title: scenario.title,
        prompt: target,
        promptInput: { scene: brief.scenario === "colorway" ? "garment-colorway" : "local-restyle",
            fields: { change: target, description: target, colorMood: target, colorMode: "smart", preserve, restyleArea: "用户指定部位" },
            userText: target, referenceRoles: ["服装主图"], mode: "edit" },
        references: [{ ...primary }],
    };
}
