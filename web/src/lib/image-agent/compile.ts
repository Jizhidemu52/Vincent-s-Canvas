import { ImageAgentPlanningError, parseImageAgentEditSpec, type ImageAgentEditSpec } from "../../../../shared/image-agent-iteration";
import { designRequirementsText, type DesignRequirements } from "../../../../shared/image-agent-documents";

/** Code-owned scope protection, separate from the user's explicit keep-list provenance. */
export const IMAGE_AGENT_BASE_PRESERVATION = "仅修改本轮明确要求的内容；未涉及的主体剪影、版型结构、配色、面料纹理、印花与文字、辅料数量、人物特征、背景、光影和构图保持与修改底图当前可见状态一致。保留项中的历史加宽、缩短、旋转或相对倍率仅是旧记录，不作为本轮增量，也不重新套用到修改底图；发生歧义时保持底图现状。合法静态尺寸、数量和比例原样保留。本轮明确要求的变化优先，明确要求再次变化时仍执行，不把保留规则用于阻止这些变化；不要擅自新增商标、文字或装饰。";
type Image = { id: string; label: string };
const roleLabels = { base: "修改底图", material: "面料或花型", color: "配色", model: "模特", pose: "姿势", background: "背景或场景", style: "风格", reference: "辅助参考" };

/** Retains the complete planner prompt. Specifications refine execution, never select a different base. */
export function compileImageAgentPrompt(input: { prompt: string; keep: readonly string[]; images: readonly Image[]; baseImageId?: string; spec?: unknown; requirements?: DesignRequirements }) {
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
    const prompt = [order ? `本次提供的图片顺序：${order}。` : "",
        input.requirements ? `已确认的文件设计要求（本轮明确修改优先；未知项不作为事实）：\n${designRequirementsText(input.requirements)}` : "", input.prompt.trim(),
        ...(spec ? ["本轮具体变化：", ...spec.changes.map(item => `- ${item}`), spec.region ? `修改区域：${spec.region}` : ""] : []),
        ...(roles?.length ? ["图片分工：", ...roles] : []),
        input.keep.length ? `需要保持：${input.keep.join("；")}` : "",
        input.baseImageId ? IMAGE_AGENT_BASE_PRESERVATION : "",
        ...(spec?.acceptance?.length ? ["结果应满足：", ...spec.acceptance.map(item => `- ${item}`)] : []),
    ].filter(Boolean).join("\n\n");
    if (!prompt || prompt.length > 20_000) throw new ImageAgentPlanningError("IMAGE_AGENT_SPEC_INVALID", "完整图片要求超过20000字符或为空，请精简完整要求；尚未提交生成。");
    return { prompt, spec };
}

export function imageAgentSpecText(spec?: ImageAgentEditSpec) {
    if (!spec) return "";
    return [spec.region ? `区域：${spec.region}` : "", `本轮修改：${spec.changes.join("；")}`,
        spec.acceptance?.length ? `待核对：${spec.acceptance.join("；")}` : "",
        spec.assumptions?.length ? `本轮假设：${spec.assumptions.join("；")}` : ""].filter(Boolean).join("\n");
}
