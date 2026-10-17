import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import type { ReferenceImage } from "@/types/image";

export type CreativeReferenceRole = {
    image_id: string;
    role: "target" | "reference";
    purpose: string;
    do_not_transfer?: string;
    prompt_label?: string;
};

type ExecutionInput = {
    prompt: string;
    preserve: string[];
    references: ReferenceImage[];
    catalog?: Array<{ id: string; label: string }>;
    referenceRoles?: unknown;
    supersededConstraints?: unknown;
};

const normalizeConstraint = (text: string) => text.trim().replace(/\s+/g, " ");
const numeralPattern = "[0-9一二三四五六七八九十两]+";
const labelPattern = `(?:图(?:片)?\\s*${numeralPattern}|第\\s*${numeralPattern}\\s*张(?:图(?:片)?)?|(?:image|reference\\s+image)\\s*#?\\s*[0-9]+)`;

function labelNumber(label: string) {
    const value = label.match(/[0-9]+|[一二三四五六七八九十两]+/)?.[0];
    if (!value) return undefined;
    if (/^[0-9]+$/.test(value)) return Number(value);
    const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (value === "十") return 10;
    if (value.includes("十")) {
        const [tens, units] = value.split("十");
        if ((tens && !digits[tens]) || (units && !digits[units])) return undefined;
        return (tens ? digits[tens]! : 1) * 10 + (units ? digits[units]! : 0);
    }
    return digits[value];
}

function readRoles(value: unknown, references: ReferenceImage[]): CreativeReferenceRole[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length !== references.length) throw new Error("图片分工必须覆盖本次全部选图，未提交图片任务");
    const seen = new Set<string>();
    return value.map((item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("图片分工格式无效，未提交图片任务");
        const role = item as Record<string, unknown>;
        const index = references.findIndex((reference) => reference.id === role.image_id);
        if (Object.keys(role).some((key) => !["image_id", "role", "purpose", "do_not_transfer", "prompt_label"].includes(key))
            || typeof role.image_id !== "string" || index < 0 || seen.has(role.image_id)
            || role.role !== (index === 0 ? "target" : "reference")
            || typeof role.purpose !== "string" || !role.purpose.trim() || role.purpose.length > 400
            || (role.do_not_transfer !== undefined && (typeof role.do_not_transfer !== "string" || !role.do_not_transfer.trim() || role.do_not_transfer.length > 400))
            || (role.prompt_label !== undefined && (typeof role.prompt_label !== "string" || !new RegExp(`^${labelPattern}$`, "i").test(role.prompt_label.trim())))) {
            throw new Error("图片分工与目标或辅助图不一致，未提交图片任务");
        }
        seen.add(role.image_id);
        return role as CreativeReferenceRole;
    });
}

/** Pure replay boundary: no model, media reads, state writes, or task submission. */
export function compileCreativeChatExecutionPrompt(input: ExecutionInput) {
    const { references } = input;
    if (new Set(references.map((item) => item.id)).size !== references.length) throw new Error("实际选图标识重复，未提交图片任务");
    const roles = readRoles(input.referenceRoles, references);
    const superseded = input.supersededConstraints ?? [];
    if (!Array.isArray(superseded) || superseded.length > 20 || superseded.some((item) => typeof item !== "string" || !item.trim() || item.length > 400)) {
        throw new Error("撤销约束格式无效，未提交图片任务");
    }
    const slots = new Map(references.map((reference, index) => [reference.id, index + 1]));
    const explicitLabels = new Map<number, number>();
    for (const role of roles) {
        if (!role.prompt_label) continue;
        const number = labelNumber(role.prompt_label);
        const slot = slots.get(role.image_id)!;
        if (!number || (explicitLabels.has(number) && explicitLabels.get(number) !== slot)) throw new Error("图片分工中的图号绑定重复或无效，未提交图片任务");
        explicitLabels.set(number, slot);
    }
    const resolveNumber = (label: string) => {
        const number = labelNumber(label);
        if (!number) throw new Error(`无法识别图片引用“${label}”，未提交图片任务`);
        if (explicitLabels.has(number)) return explicitLabels.get(number)!;
        const catalogMatches = input.catalog?.filter((entry) => labelNumber(entry.label) === number) || [];
        const catalogSlots = catalogMatches.map((entry) => slots.get(entry.id)).filter((slot): slot is number => slot !== undefined);
        if (catalogMatches.length && !catalogSlots.length) throw new Error(`图片引用“${label}”指向目录中未选入的图片，不能按本次序号替代；请明确图片分工，未提交图片任务`);
        const localSlot = number <= references.length ? number : undefined;
        const possible = new Set([...catalogSlots, ...(localSlot ? [localSlot] : [])]);
        if (catalogMatches.length > 1 || possible.size > 1) throw new Error(`图片引用“${label}”在历史目录与本次输入中指向不同图片，请明确图片分工后再试；未提交图片任务`);
        if (possible.size !== 1) throw new Error(`图片引用“${label}”未对应本次选图，请明确需要使用的图片；未提交图片任务`);
        return [...possible][0]!;
    };
    const rewrite = (text: string) => text.split(/("[^"\n]*"|“[^”\n]*”|「[^」\n]*」)/).map((part, index) => {
        // Quoted text is literal artwork/copy, not an image pointer.
        if (index % 2) return part;
        const stable = part.replace(/\{\{image:([^{}]+)\}\}/g, (_match, id: string) => {
            const slot = slots.get(id.trim());
            if (!slot) throw new Error("执行要求引用了本次选图以外的 image_id，未提交图片任务");
            return `\u0001${slot}\u0002`;
        });
        if (stable.includes("{{image:")) throw new Error("执行要求中的 image_id 引用格式无效，未提交图片任务");
        return stable.replace(new RegExp(labelPattern, "gi"), (label) => {
            // With no input images, a bare ordinal can describe the requested output (e.g. 第一张海报).
            if (!references.length && new RegExp(`^第\\s*${numeralPattern}\\s*张$`).test(label)) return label;
            return `\u0001${resolveNumber(label)}\u0002`;
        })
            .replace(/\u0001([0-9]+)\u0002/g, (_match, slot: string) => `图片${slot}`);
    }).join("");
    const removed = new Set((superseded as string[]).map(normalizeConstraint));
    // Never merge historical lineage here: only this turn's still-valid branch constraints execute.
    const preservedConstraints = [...new Set(input.preserve.filter((item) => !removed.has(normalizeConstraint(item))).map((item) => rewrite(item.trim())))];
    const referenceLines = references.map((reference, index) => {
        const role = roles.find((item) => item.image_id === reference.id);
        const purpose = role?.purpose || (index === 0 ? "本轮修改主体，以本轮要求决定修改范围。" : "仅按本轮要求提供辅助参考，不自动替换修改主体。必要分工以本轮要求为准。");
        return `- 图片${index + 1}（${index === 0 ? "修改主体" : "辅助参考"}）：${rewrite(purpose)}${role?.do_not_transfer ? ` 不迁移：${rewrite(role.do_not_transfer)}` : ""}`;
    });
    const prompt = [
        "【本轮修改要求（最高优先级）】",
        rewrite(input.prompt.trim()),
        "本轮明确修改或撤销的要求优先于旧版本条件；下列保留项仅在不与本轮修改冲突时适用，不把旧版本当作已获用户认可。",
        ...(referenceLines.length ? ["【参考图分工（按实际输入顺序）】", ...referenceLines] : []),
        "【本轮仍有效的保留项】",
        ...(preservedConstraints.length ? preservedConstraints.map((item) => `- ${item}`) : ["未额外指定；不得从其他历史分支擅自补充约束。"]),
    ].join("\n");
    // requestEdit adds this shared prefix later; count it now and never silently truncate requirements.
    if (buildImageReferencePromptText(prompt, references).length > 20_000) throw new Error("完整执行要求超过 20000 字符，请精简本轮要求与保留项；未提交图片任务");
    return { prompt, preservedConstraints };
}
