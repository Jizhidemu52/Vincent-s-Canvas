import type { CreativeImageCatalogEntry } from "@/lib/creative-chat";
import type { ChatGeneratedImage } from "./chat-types";

/** A draft only. The exact generation base stays authoritative, not a guessed ancestor. */
export function prepareChatImageCorrection(image: ChatGeneratedImage, catalog: CreativeImageCatalogEntry[]) {
    if (!image.review) throw new Error("请先检查结果，再准备纠正要求。");
    const base = catalog.find(item => item.id === image.parentId && !item.unavailableReason);
    if (!base) throw new Error("本轮实际底图不可用，不能自动换图纠正。请重新提供并选择底图。");
    const issues = image.review.report.checks.filter(check => check.result !== "pass");
    if (!issues.length) throw new Error("检查没有提出待纠正项；你仍可自行描述需要调整的内容。");
    if (!image.prompt?.trim()) throw new Error("本轮完整原要求不可用，不能自动准备纠正草稿。请重新说明要求；没有提交任务。");
    const referenceIds = image.referenceImageIds ?? image.spec?.reference_roles?.map(role => role.image_id) ?? [];
    const references = [...new Set(referenceIds)].filter(id => id !== base.id).map(id => {
        const reference = catalog.find(item => item.id === id && !item.unavailableReason);
        if (!reference) throw new Error("本轮参考图不可用，请先重新添加；没有修改草稿或提交任务。");
        return reference;
    });
    const prompt = [
        "请基于已锁定的本轮实际底图重新完成以下要求。AI 检查仅作为待核对线索，不把不确定项当作既成事实。",
        `原修改要求：${image.prompt}`,
        image.workNote?.keep.length ? `保持：${image.workNote.keep.join("；")}` : "",
        ...issues.map(check => `待核对并纠正：${check.criterion}。检查线索：${check.evidence}`),
        "只修改上述明确要求的部分，其他内容与底图保持一致。",
    ].filter(Boolean).join("\n");
    return { base, references, prompt };
}
