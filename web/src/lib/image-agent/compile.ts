import { ImageAgentPlanningError, parseImageAgentEditSpec, type ImageAgentEditSpec } from "../../../../shared/image-agent-iteration";
import { designRequirementsText, type DesignRequirements } from "../../../../shared/image-agent-documents";
import { assertImagePromptInvariantCoverage } from "../../../../shared/image-prompt-invariants";

/** Code-owned scope protection, separate from the user's explicit keep-list provenance. */
export const IMAGE_AGENT_BASE_PRESERVATION = "除本次明确修改外，其余保持底图不变。";
type Image = { id: string; label: string };
const roleLabels = { base: "修改底图", material: "面料或花型", color: "配色", model: "模特", pose: "姿势", background: "背景或场景", style: "风格", reference: "辅助参考" };

/** Retains the complete planner prompt. Specifications refine execution, never select a different base. */
export function compileImageAgentPrompt(input: { prompt: string; keep: readonly string[]; images: readonly Image[]; baseImageId?: string; spec?: unknown; requirements?: DesignRequirements; userPrompt?: string }) {
    if (!input.prompt.trim()) throw new ImageAgentPlanningError("IMAGE_AGENT_SPEC_INVALID", "缺少本次具体图片修改要求；取消保留项不会单独提交图片任务。");
    const spec = input.spec === undefined ? undefined : parseImageAgentEditSpec(input.spec);
    if (input.baseImageId && input.images[0]?.id !== input.baseImageId) throw new ImageAgentPlanningError("IMAGE_AGENT_REFERENCES_INVALID", "修改底图必须是实际输入的第一张图片，尚未提交生成。");
    if (new Set(input.images.map(image => image.id)).size !== input.images.length) throw new ImageAgentPlanningError("IMAGE_AGENT_REFERENCES_INVALID", "实际输入图片重复，尚未提交生成。");
    if (spec?.reference_roles) {
        const used = new Set<string>();
        spec.reference_roles = spec.reference_roles.map(role => {
            const image = input.images.find(image => image.id === role.image_id || image.label === role.image_id);
            if (!image || used.has(image.id) || (role.role === "base") !== (image.id === input.baseImageId)) throw new ImageAgentPlanningError("IMAGE_AGENT_REFERENCES_INVALID", "图片分工必须对应本轮实际底图与参考图，不能替换、重复或使用未选入的图片。");
            used.add(image.id);
            return { ...role, image_id: image.id };
        });
        if (used.size !== input.images.length) throw new ImageAgentPlanningError("IMAGE_AGENT_REFERENCES_INVALID", "图片分工需要覆盖本轮全部输入图片，尚未提交生成。");
    }
    const order = input.images.map((image, index) => `输入图${index + 1}对应${image.label}${image.id === input.baseImageId ? "（修改底图）" : "（参考图）"}`).join("；");
    const roles = spec?.reference_roles?.map(role => {
        const index = input.images.findIndex(image => image.id === role.image_id);
        return `- 输入图${index + 1}：${roleLabels[role.role]}。${role.purpose}${role.do_not_transfer ? ` 不迁移：${role.do_not_transfer}` : ""}`;
    });
    const additionalChanges = spec?.changes.filter(item => !input.prompt.includes(item)) || [];
    const prompt = [order ? `${order}。` : "",
        input.requirements ? `文件设计要求：\n${designRequirementsText({ ...input.requirements, unknowns: [] })}` : "",
        ...(roles?.length ? ["图片分工：", ...roles] : []),
        input.keep.length ? `保持底图当前状态：${input.keep.join("；")}` : "",
        input.baseImageId ? IMAGE_AGENT_BASE_PRESERVATION : "",
        input.prompt.trim(),
        ...additionalChanges.map(item => `- ${item}`),
        spec?.region ? `修改区域：${spec.region}` : "",
    ].filter(Boolean).join("\n\n");
    if (!prompt || prompt.length > 20_000) throw new ImageAgentPlanningError("IMAGE_AGENT_SPEC_INVALID", "完整图片要求超过20000字符或为空，请精简完整要求；尚未提交生成。");
    if (input.userPrompt) assertImagePromptInvariantCoverage(input.userPrompt, prompt, { negation: false });
    return { prompt, spec };
}

export function imageAgentSpecText(spec?: ImageAgentEditSpec) {
    if (!spec) return "";
    return [spec.region ? `区域：${spec.region}` : "", `本轮修改：${spec.changes.join("；")}`,
        spec.acceptance?.length ? `待核对：${spec.acceptance.join("；")}` : "",
        spec.assumptions?.length ? `本轮假设：${spec.assumptions.join("；")}` : ""].filter(Boolean).join("\n");
}
