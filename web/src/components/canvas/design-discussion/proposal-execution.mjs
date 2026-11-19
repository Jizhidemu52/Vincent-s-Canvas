import { transformImagePromptInstructions } from "../../../../../shared/image-prompt-invariants.ts";
import { assertReferenceMentions, readAssistantResult } from "./design-assistant.mjs";
import { createDesignRecord, validateDesignRecord, validateReferenceRoles } from "./design-record.mjs";

const fail = message => new Error(`方案无法执行：${message}；没有提交图片生成。`);
const chineseNumbers = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const imageMentions = /(?:图片|图)\s*([1-9]\d*|[一二三四五六七八九十])(?![\d一二三四五六七八九十])|\bimage\s*#?\s*([1-9]\d*)\b/giu;
const phaseOnly = [
    /^(?:(?:请|我们|咱们)\s*)?(?:(?:先|现在|目前|暂时)\s*)?(?:(?:只|仅)\s*)?(?:讨论(?:一下)?(?:设计|方案|方向)?|聊(?:聊|一下)?(?:设计|方案|方向)?)$/iu,
    /^(?:(?:请|本轮|现在|目前|先|暂时)\s*)*(?:暂不|暂时不|先不|不要|不用|无需|不|先别|别)\s*(?:自动|直接|立即|先)?\s*(?:生成(?:图片)?|出图|生图|绘图|(?:提(?:出)?|提供|给出|展示|输出)(?:完整)?方案)(?:[了吧])?$/iu,
    /^(?:请\s*)?(?:禁止|不得|不许)\s*自动\s*(?:生成(?:图片)?|出图|生图|绘图)$/iu,
    /^(?:please\s+)?(?:do not|don't)\s+(?:generate|render)(?:\s+images?)?(?:\s+(?:yet|for now))?$/iu,
];

function boundedText(value, max, name, allowEmpty = false) {
    if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) throw fail(`${name}无效或过长`);
    return value.trim();
}

function list(value, max, name, min = 0) {
    if (!Array.isArray(value) || value.length < min || value.length > max) throw fail(`${name}数量无效`);
    return value;
}

function unique(values, name) {
    if (new Set(values).size !== values.length) throw fail(`${name}重复`);
    return values;
}

function plainObject(value, keys, name) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail(`${name}字段无效`);
    return value;
}

function jsonData(value, max, name) {
    let serialized;
    try { serialized = JSON.stringify(value); } catch { throw fail(`${name}不是可保存的数据`); }
    if (!serialized || serialized.length > max) throw fail(`${name}无效或过长`);
    return JSON.parse(serialized);
}

function checkedSnapshot(value) {
    if (value === undefined) return undefined;
    const snapshot = list(value, 4, "原图片快照").map(reference => {
        plainObject(reference, ["id", "title", "role", "label"], "原图片快照");
        const label = boundedText(reference.label, 20, "原图号");
        if (!/^图[1-4]$/.test(label)) throw fail("原图号无效");
        return { id: boundedText(reference.id, 160, "原图片编号"), title: boundedText(reference.title, 300, "原图片名称"), role: reference.role || "auto", label };
    });
    unique(snapshot.map(reference => reference.id), "原图片编号");
    unique(snapshot.map(reference => reference.label), "原图号");
    validateReferenceRoles(snapshot);
    return snapshot;
}

function removeSupersededDiscussionTiming(value) {
    return transformImagePromptInstructions(value, span => span.split(/(?<=[、，,。;；.!?！？\n])/u).filter(part => {
        const clause = part.trim().replace(/[、，,。;；.!?！？]+$/u, "").trim();
        return !phaseOnly.some(pattern => pattern.test(clause));
    }).join("")).trim();
}

function remapRequirement(value, snapshot, selected) {
    return transformImagePromptInstructions(value, span => span.replace(imageMentions, (_, chinese, english) => {
        if (snapshot === undefined) throw fail("带图号的用户要求缺少原图片快照，请更新该条要求后再选方案");
        const number = english ? Number(english) : chineseNumbers[chinese] || Number(chinese);
        const original = snapshot.find(reference => reference.label === `图${number}`);
        if (!original) throw fail(`用户要求中的图${number}不在该轮图片快照中，请更新要求`);
        const currentIndex = selected.findIndex(reference => reference.id === original.id);
        if (currentIndex < 0) throw fail(`用户要求中的图${number}“${original.title}”未选入此方案，请更新对应要求或补回图片`);
        return `图${currentIndex + 1}`;
    }));
}

function checkedProposal(value) {
    plainObject(value, ["id", "title", "features", "rationale", "prompt", "referenceIds", "sourceNotes"], "已选方案");
    return {
        id: boundedText(value.id, 100, "方案编号"), title: boundedText(value.title, 120, "方案标题"),
        features: unique(list(value.features, 6, "方案特点", 2).map(feature => boundedText(feature, 500, "方案特点")), "方案特点"),
        rationale: boundedText(value.rationale, 2000, "方案依据"), prompt: boundedText(value.prompt, 12000, "方案描述"),
        referenceIds: unique(list(value.referenceIds, 4, "方案参考图").map(id => boundedText(id, 160, "方案参考图编号")), "方案参考图"),
        sourceNotes: list(value.sourceNotes, 6, "方案来源说明").map(note => boundedText(note, 700, "方案来源说明")),
    };
}

export function createProposalExecution({ proposal, references, userRequirements = [], designRecord = createDesignRecord(), designRecordReferenceSnapshot, brief = {}, conversation = [], modelId, outputKind = "image", generationAllowed, serverImageExecution = false } = {}) {
    if (generationAllowed !== true) throw fail("必须由用户明确点击已选方案的生成操作");
    const model = serverImageExecution && outputKind === "image" ? "" : boundedText(modelId, 200, "生图模型");
    const candidate = checkedProposal(proposal);
    const current = list(references, 4, "当前参考图").map(reference => {
        if (!reference || typeof reference !== "object") throw fail("当前参考图无效");
        boundedText(reference.id, 160, "当前图片编号");
        boundedText(reference.title, 300, "当前图片名称");
        boundedText(reference.image, 12 * 1024 * 1024, "当前图片内容");
        return structuredClone(reference);
    });
    unique(current.map(reference => reference.id), "当前图片编号");
    validateReferenceRoles(current);
    const selected = candidate.referenceIds.map(id => current.find(reference => reference.id === id));
    if (selected.some(reference => !reference)) throw fail("所选方案引用了当前没有提供的图片，请重新整理方案");
    if (current.length && !selected.length) throw fail("所选方案遗漏了当前参考图");
    const declared = current.filter(reference => reference.role && reference.role !== "auto");
    if (declared.some(reference => !candidate.referenceIds.includes(reference.id))) throw fail("所选方案遗漏了用户明确指定用途的参考图");
    const base = declared.find(reference => reference.role === "base");
    if (base && selected[0]?.id !== base.id) throw fail("明确指定的修改底图必须是方案第一张图片，不能自动改换方案图号");
    assertReferenceMentions(candidate.prompt, selected);
    validateDesignRecord(designRecord);
    const recordSnapshot = checkedSnapshot(designRecordReferenceSnapshot);
    const mappedConstraints = designRecord.constraints.map(constraint => remapRequirement(constraint, recordSnapshot, selected));
    const objective = remapRequirement(designRecord.objective, recordSnapshot, selected);
    const requirements = list(userRequirements, 32, "有效用户要求").map(requirement => {
        plainObject(requirement, ["text", "referenceSnapshot"], "有效用户要求");
        const originalText = boundedText(requirement.text, 8000, "用户原始要求");
        const referenceSnapshot = checkedSnapshot(requirement.referenceSnapshot);
        const effectiveText = remapRequirement(removeSupersededDiscussionTiming(originalText), referenceSnapshot, selected);
        return { originalText, effectiveText, ...(referenceSnapshot ? { referenceSnapshot } : {}) };
    });
    const independentText = [objective, ...requirements.map(requirement => requirement.effectiveText)].filter(Boolean).join("\n");
    if (!independentText && !mappedConstraints.length) throw fail("缺少独立的用户设计要求，不能只拿模型方案校验自身");
    const userText = boundedText(independentText || mappedConstraints.join("；"), 10000, "本次有效设计要求");
    const record = { ...structuredClone(designRecord), objective, constraints: mappedConstraints };
    const toolArguments = {
        base: base?.id || "none", references: selected.filter(reference => reference.id !== base?.id).map(reference => reference.id), prompt: candidate.prompt,
    };
    const result = readAssistantResult({ content: `已选择方案：${candidate.title}`, toolCalls: [{ function: { name: "edit_image", arguments: JSON.stringify(toolArguments) } }] }, selected, userText, false, record);
    if (!result.plan?.generationAllowed) throw fail("所选方案没有通过执行校验");
    if (!brief || typeof brief !== "object" || Array.isArray(brief)) throw fail("设计资料无效");
    list(conversation, 200, "对话记录");
    const savedBrief = jsonData(brief, 30000, "设计资料");
    const savedConversation = jsonData(conversation, 120000, "对话记录");
    const prompt = [
        `当前独立任务只执行已选方案「${candidate.title}」。历史需求中的可选方案数量、其他配色方向和独立生成次数由应用拆单处理，不是当前画面中的产品数量。只落实下面这一项已选方案，不把其他备选方案拼进同一画面。用户明确指定的单张构图、多视图或排版仍须保留。`,
        result.plan.prompt,
        `本任务唯一选定的执行方案：\n${candidate.prompt}`,
    ].join("\n\n");
    if (prompt.length > 20000) throw fail("完整要求超过 20000 字符，请精简后重新提方案");
    return {
        ...result.plan, prompt, mediaKind: outputKind, modelId: model, brief: savedBrief, conversation: savedConversation, generationAllowed: true,
        proposal: { ...candidate,
            references: selected.map((reference, index) => ({ id: reference.id, title: reference.title, role: reference.role || "auto", label: `图${index + 1}`, originalLabel: `图${current.findIndex(item => item.id === reference.id) + 1}`, kind: reference.kind || "reference" })),
            requirementEvidence: requirements,
        },
    };
}
