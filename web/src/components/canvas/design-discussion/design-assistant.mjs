import { compileImageAgentPrompt } from "../../../../../shared/image-agent/compile.ts";
import { createClientUuid } from "../../../lib/client-uuid.ts";
import { ImageAgentPlanningError, isImageAgentPlanningIssue, parseImageAgentEditSpec, parseImageAgentReview } from "../../../../../shared/image-agent-iteration.ts";
import { transformImagePromptInstructions } from "../../../../../shared/image-prompt-invariants.ts";
import { fashionContext } from "./fashion-context.mjs";
import { brandKnowledgeMessage } from "./brand-knowledge.mjs";
import { applyReferenceRoles, createDesignRecord, designRecordMessage, nextDesignRecord, validateDesignRecord, validateReferenceRoles } from "./design-record.mjs";
import { createExecutionContract, executionRequirementsText, validatePlannedExecution } from "./design-contract.mjs";

export const DESIGN_CONTEXT = "本板块服务于服装和配饰设计师。常见工作包括：提取完整白底商品图并保留针织纹理；多张参考图分别提供款式、颜色、纱线肌理、图案或模特；局部结构与辅料微调；背面推演；图案提取与工艺效果；在指定色板内探索不同配色。参考图顺序不等于用途，色卡可能是图1而真正修改对象是图2。用户经常简短表达，如‘用1的颜色生成2’‘纽扣缩小20%’；数量、范围、幅度与明确的不变项非常重要。连续修改基于当前结果可见状态，旧修改幅度不能再执行一遍。用户可能要求把九个方案放在一张图中，这与九次独立生成不同。此演示每次只执行一张图片；多张独立出图需求先讨论方案，不声称已批量完成。正背面推演、近似配色、绣花观感或位图不等于真实背面、生产色标、绣花机文件或矢量文件。没有图像证据时不能宣称已看见或已经验收。";
export const DEMO_PLAN_FORMAT = "本 Demo 使用 edit_image 的最简参数形式：只给 base、references、prompt 三个顶层字段。base 使用本轮修改对象的精确 ID；references 只列辅助图片 ID，不重复底图。prompt 写全本轮要求与仍有效的保留项，优先保持用户原话。省略可选的 keep、note_update、edit_spec，不要在任何嵌套对象中输出它们；应用已负责记录用户锁定项、持续目标与图片分工。";

export const DESIGN_EXAMPLES = [
    { title: "白底商品图", prompt: "提取图1中的服装，生成完整的白底平铺商品图，去掉模特和衣架，保留原版型、领型和针织纹理。" },
    { title: "参考图分工", prompt: "图1提供颜色，图2是要修改的款式；只换图2的颜色，其余保持不变。" },
    { title: "先聊设计", prompt: "先分析图1的版型与材质，给我几个可行的改款方向，暂时不要生成。" },
    { title: "局部微调", prompt: "只把图1上的纽扣缩小20%，保持纽扣数量、位置、其他结构与颜色不变。" },
];

export function assertReferenceMentions(prompt, references) {
    const chinese = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const missing = new Set();
    transformImagePromptInstructions(prompt, text => {
        for (const match of text.matchAll(/(?:图片|图)\s*([1-9]\d*|[一二三四五六七八九十])(?![\d一二三四五六七八九十])/g)) {
            const index = chinese[match[1]] || Number(match[1]);
            if (!references[index - 1]) missing.add(index);
        }
        return text;
    });
    if (missing.size) throw new Error(`你提到了${[...missing].map(index => `图${index}`).join("、")}，但本轮没有这些图片。请先补充参考图；尚未调用模型。`);
}

export function assistantRequest({ prompt, references, previews, history = [], review, brief = {}, discussionOnly = true, designRecord = createDesignRecord(), cases = [], knowledgeMode = "full", repairIssue }) {
    if (repairIssue && (!isImageAgentPlanningIssue(repairIssue) || review || discussionOnly)) throw new Error("本轮不适用规划修复，没有调用模型。");
    const imageCatalog = references.map((image, index) => ({ id: image.id, label: `图${index + 1}`, name: image.title.slice(0, 120), kind: image.kind === "result" ? "result" : "upload", previewed: true,
        ...(image.parentId ? { parentId: image.parentId } : {}), ...(image.workNote ? { designBrief: `历史计划，不是图像事实：${image.workNote.slice(0, 1500)}` } : {}) }));
    if (previews.length !== references.length || references.length > 5) throw new Error("图片预览与参考图不一致，尚未调用模型。");
    const content = references.flatMap((image, index) => [{ type: "input_text", text: `本轮图${index + 1}（image_id=${image.id}）${review?.resultImageId === image.id ? "：本轮实际生成结果" : ""}` }, { type: "input_image", image_url: previews[index] }]);
    const workNote = references.find(ref => ref.kind === "result")?.workNote || "";
    const focus = references.find(ref => ref.role === "base") || (references.length === 1 ? references[0] : null);
    const contract = !review && !discussionOnly ? createExecutionContract(prompt, designRecord.constraints) : null;
    const protocol = !review && !discussionOnly ? `${DEMO_PLAN_FORMAT}\n${focus ? `本轮修改对象 image_id=${focus.id}。` : "请根据本轮要求选择底图。"}kind=result只表示来自上一轮生成，不是辅助角色。继续改图使用当前结果，不返回历史原图。锁定原有质感时不可自行增加明线、包边或替换面料。` : "";
    return {
        requestId: createClientUuid(), toolKey: "canvas-design-chat", profile: "creative-chat", tools: [], webSearch: false, claude: { stream: false, maxTokens: 8192 },
        profileContext: { stage: review ? "review" : repairIssue ? "repair" : "plan", ...(repairIssue ? { repairIssue } : {}), currentUserText: prompt, newCreation: !references.length,
            ...(focus ? { focusImageId: focus.id } : {}), imageCatalog, previewImageIds: references.map(ref => ref.id),
            workNote: workNote ? `历史规划，未核实是否达成：${workNote.slice(0, 760)}` : "", memoryContext: [DESIGN_CONTEXT, fashionContext(brief), "必须遵守设计记录中用户指定的图片分工和锁定项。faithful只执行本轮修改；creative可在约束内提出新方向；auto按本轮意图判断。历史摘要只记录计划，不证明结果符合。note_update只描述本轮目标，不写已经完成或已获认可；实际状态必须重新看图。", review ? "本轮仅对照原要求进行只读验图，返回 report_image_review；禁止生成或自动纠错。" : discussionOnly ? "本轮仅讨论，用户未授权生成。只回答文字，不调用 edit_image。" : "用户已点击生成，但仍须遵守原要求、锁定项和执行契约。遇到冲突或必需资料不足只说明问题，不猜测出图。"].join("\n"), ...(review ? { reviewContext: review } : {}) },
        input: [...history.slice(-8).map(message => ({ role: message.role, content: message.content })), ...(knowledgeMode !== "none" ? [{ role: "user", content: brandKnowledgeMessage(brief, prompt) }] : []), ...(knowledgeMode === "full" ? [{ role: "user", content: designRecordMessage(designRecord, references, cases) }] : []), ...(contract ? [{ role: "user", content: executionRequirementsText(contract) }] : []), ...(content.length ? [{ role: "user", content }] : []), ...(protocol ? [{ role: "user", content: protocol }] : []), { role: "user", content: prompt }],
    };
}

export function readAssistantResult(result, references, userText, discussionOnly = true, designRecord = createDesignRecord()) {
    validateDesignRecord(designRecord);
    if (["max_tokens", "length", "incomplete", "error", "content_filter"].includes(result.stopReason || "")) throw new Error("助手回复未完整返回，没有提交生成；可修改需求后再次发送。");
    const content = typeof result.content === "string" ? result.content : "";
    const calls = result.toolCalls || [];
    if (!calls.length) {
        if (!content.trim()) throw new Error("助手没有返回内容，没有提交生成。");
        return { content, plan: null };
    }
    if (discussionOnly) throw new Error("本轮设置为只聊设计，未执行助手提出的出图操作。请明确你想讨论的问题后发送；没有提交生图。");
    const contract = createExecutionContract(userText, designRecord.constraints);
    if (calls.length !== 1 || calls[0].function?.name !== "edit_image") throw new Error("助手需要其他资料或返回了当前 Demo 未支持的操作。请补充图片或明确一项需求；没有提交生成。");
    let args;
    try { args = JSON.parse(calls[0].function.arguments); }
    catch { throw new ImageAgentPlanningError("IMAGE_AGENT_ARGUMENTS_INVALID", "助手规划不是完整 JSON，没有提交生成。"); }
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => !["base", "references", "prompt", "keep", "note_update", "edit_spec"].includes(key))) throw new Error("助手规划格式无效，没有提交生成。");
    if (typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > 20000
        || (args.references !== undefined && (!Array.isArray(args.references) || args.references.length > 4 || args.references.some(value => typeof value !== "string")))
        || (args.keep !== undefined && (!Array.isArray(args.keep) || args.keep.length > 20 || args.keep.some(value => typeof value !== "string" || !value.trim() || value.length > 400)))
        || (args.note_update !== undefined && (typeof args.note_update !== "string" || args.note_update.length > 800))) throw new Error("助手规划内容不完整，没有提交生成。");
    const resolve = value => references.find(ref => ref.id === value) || references.find((_, index) => value === `图${index + 1}` || value === `图片${index + 1}`);
    let base;
    if (args.base !== "none" && references.length) {
        base = args.base === "focus" || args.base === undefined ? references.find(ref => ref.role === "base") || (references.length === 1 ? references[0] : undefined) : resolve(args.base);
        if (!base) throw new Error("需要明确本轮修改哪张图；未猜选底图，没有提交生成。");
    } else if (!references.length && args.base && !["none", "focus"].includes(args.base)) throw new Error("助手引用了不存在的底图，没有提交生成。");
    const extra = (args.references || []).map(value => {
        const ref = resolve(value);
        if (!ref) throw new Error("助手引用了本轮没有提供的参考图，请补充后再发送。");
        return ref;
    });
    const ordered = [...(base ? [base] : []), ...extra];
    if (new Set(ordered.map(ref => ref.id)).size !== ordered.length || ordered.length > 4) throw new Error("参考图重复或数量超限，没有提交生成。");
    const keep = [...designRecord.constraints];
    const spec = applyReferenceRoles(references, ordered, base, args.edit_spec === undefined ? undefined : parseImageAgentEditSpec(args.edit_spec));
    const images = ordered.map(ref => ({ ...ref, label: `图${references.findIndex(item => item.id === ref.id) + 1}` }));
    const plannedText = [args.prompt, ...(args.keep || []), ...(spec?.changes || [])].join("\n");
    validatePlannedExecution(contract, plannedText);
    const prompt = [executionRequirementsText(contract), "模型执行提案（必须服从上述原要求，不是已完成状态）：", args.prompt,
        args.keep?.length ? `本轮规划建议保留项（非图像观测）：${args.keep.join("；")}` : ""].filter(Boolean).join("\n\n");
    const compiled = compileImageAgentPrompt({ prompt, keep: [], images, baseImageId: base?.id, spec, userPrompt: userText });
    const plan = { prompt: compiled.prompt, userText, references: ordered, baseId: base?.id, keep, spec: compiled.spec, executionContract: contract, generationAllowed: true,
        workNote: `本轮规划目标（结果待核对）：${userText.slice(0, 760)}`, sourcePrompt: args.prompt };
    const parentRecord = { ...designRecord, id: base?.designRecord?.id || designRecord.id, parentTaskId: base?.taskId || null, revision: base?.designRecord?.revision || (base?.taskId && designRecord.parentTaskId === base.taskId ? designRecord.revision : 0) };
    return { content, plan: { ...plan, designRecord: nextDesignRecord(parentRecord, plan, userText) } };
}

export async function previewImage(reference) {
    const image = new Image();
    image.decoding = "async";
    image.src = reference.image;
    await image.decode();
    const scale = Math.min(1, 1400 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const preview = canvas.toDataURL("image/jpeg", 0.88);
    if (preview.length > 2 * 1024 * 1024) throw new Error("看图预览过大，尚未调用模型。");
    return preview;
}

export async function analyzeDesign(api, ownerId, { prompt, references, history, brief, discussionOnly = true, designRecord = createDesignRecord(), cases = [], repairIssue }) {
    assertReferenceMentions(prompt, references);
    validateReferenceRoles(references);
    validateDesignRecord(designRecord);
    if (!discussionOnly) createExecutionContract(prompt, designRecord.constraints);
    const session = await api.session();
    if (session?.user?.id !== ownerId || session.user.status !== "active") throw new Error("登录身份已变化，请刷新页面。");
    const previews = await Promise.all(references.map(previewImage));
    const result = await api.assistant(assistantRequest({ prompt, references, previews, history, brief, discussionOnly, designRecord, cases, repairIssue }), ownerId);
    const after = await api.session();
    if (after?.user?.id !== ownerId || after.user.status !== "active") throw new Error("登录身份已变化，未展示旧账号回复、未提交生成，请刷新页面。");
    try { return readAssistantResult(result, references, prompt, discussionOnly, designRecord); }
    catch (error) {
        if (!discussionOnly && isImageAgentPlanningIssue(error)) error.planningIssue = { code: error.code, message: error.message, repairable: true, submitted: false };
        throw error;
    }
}

export async function reviewDesign(api, ownerId, task) {
    const session = await api.session();
    if (session?.user?.id !== ownerId || session.user.status !== "active") throw new Error("登录身份已变化，请刷新页面。");
    const resultImage = { id: `${task.id}-review-result`, title: "实际生成结果", image: task.resultUrls[0], kind: "result" };
    const references = [...task.references, resultImage];
    const previews = await Promise.all(references.map(previewImage));
    const prompt = "只读对照本轮实际生成结果、全部输入参考图和原要求，逐项说明可见证据、明显偏差与无法确认的内容。不要生成或修改，不自动纠错，不把视觉近似称为像素一致或生产验收。";
    const originalRequirements = task.executionContract ? executionRequirementsText(task.executionContract) : [task.userText || task.prompt, ...(task.designRecord?.constraints || [])].join("\n");
    const review = { resultImageId: resultImage.id, prompt: originalRequirements, ...(task.baseId ? { baseImageId: task.baseId } : {}), ...(task.spec ? { spec: task.spec } : {}) };
    const result = await api.assistant(assistantRequest({ prompt, references, previews, review, brief: task.brief, designRecord: task.designRecord || createDesignRecord() }), ownerId);
    const after = await api.session();
    if (after?.user?.id !== ownerId || after.user.status !== "active") throw new Error("登录身份已变化，未保存旧账号报告，请刷新页面。");
    if (["max_tokens", "length", "incomplete", "error"].includes(result.stopReason || "") || result.toolCalls?.length !== 1 || result.toolCalls[0].function?.name !== "report_image_review") throw new Error("检查没有返回完整报告，原生成结果未改变。");
    return parseImageAgentReview(JSON.parse(result.toolCalls[0].function.arguments));
}
