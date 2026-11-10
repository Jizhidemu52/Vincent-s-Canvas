import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageAgentKeepControls } from "@/components/image-agent-keep-controls";
import { compileImageAgentPrompt } from "@/lib/image-agent/compile";
import { imageAgentKeepRevocationDraft, imageAgentKeepRevocations, resolveImageAgentWorkNote } from "@/lib/image-agent/work-note";
import { parseCreativeChatPlan } from "@/lib/creative-chat";
import { resolveCanvasImageAgentEdit } from "@/lib/canvas/canvas-image-agent";
import { CanvasNodeType } from "@/types/canvas";

const images = [
    { id: "original", label: "图1", kind: "upload" as const, name: "original", type: "image/png", dataUrl: "data:image/png;base64,AA==", messageId: "u1", note: { summary: "蓝色", keep: ["蓝色", "白底"] } },
    { id: "v2", label: "图2", kind: "generated" as const, name: "current", type: "image/png", dataUrl: "data:image/png;base64,AQ==", messageId: "v2", parentId: "original", note: { summary: "绿色", keep: ["白底"], revokedKeep: ["蓝色"] } },
];
const call = (args: Record<string, unknown>) => ({ content: "继续改图", toolCalls: [{ id: "edit", type: "function" as const, function: { name: "edit_image", arguments: JSON.stringify(args) } }] });

test("Chinese image execution retains actual quantities and wording without a translation stage or fixed planner text", () => {
    const result = compileImageAgentPrompt({ prompt: "改为浅蓝，保留七颗纽扣和文字“ABC-123”", userPrompt: "改为浅蓝，保留七颗纽扣和文字“ABC-123”", keep: [], images: [{ id: "source", label: "图1" }], baseImageId: "source",
        spec: { changes: ["改为浅蓝"], acceptance: ["逐像素验收通过"], assumptions: ["疑似八颗纽扣，待确认"] } });
    expect(result.prompt).toContain("七颗纽扣和文字“ABC-123”");
    expect(result.prompt.match(/改为浅蓝/g)).toHaveLength(1);
    for (const text of ["逐像素验收通过", "疑似八颗纽扣", "最高优先级", "历史加宽", "本轮具体变化", "结果应满足"]) expect(result.prompt).not.toContain(text);
    expect(result.spec?.assumptions).toEqual(["疑似八颗纽扣，待确认"]);
    expect(() => compileImageAgentPrompt({ prompt: "改蓝色", userPrompt: "保留七颗纽扣和文字“ABC-123”", keep: [], images: [] })).toThrow();
});

test("draft cancellation is explicit, idempotent, and does not mutate saved notes before sending", () => {
    const note = { summary: "蓝色白底", keep: ["白底", '文字“ABC-123”不变'] };
    const before = JSON.stringify(note);
    const draft = imageAgentKeepRevocationDraft("背景改米色", "白底");
    expect(imageAgentKeepRevocationDraft(draft, "白底")).toBe(draft);
    expect(imageAgentKeepRevocations(draft)).toEqual(["白底"]);
    expect(() => resolveImageAgentWorkNote(note, undefined, [], imageAgentKeepRevocationDraft("", "白底"))).toThrow("取消项尚未生效");
    expect(resolveImageAgentWorkNote(note, undefined, undefined, "背景改米色").keep).toEqual(note.keep);
    const next = resolveImageAgentWorkNote(note, "蓝色米底", note.keep, draft);
    expect(next.keep).toEqual(['文字“ABC-123”不变']);
    expect(next.revokedKeep).toEqual(["白底"]);
    expect(JSON.stringify(note)).toBe(before);
    expect(resolveImageAgentWorkNote(next, undefined, ["白底"], "继续改袖口").keep).toEqual([]);
    expect(resolveImageAgentWorkNote(next, undefined, ["白底"], "不要白底，改为米色").keep).toEqual([]);
    expect(resolveImageAgentWorkNote(next, undefined, ["白底"], "这次恢复白底")).toEqual({ summary: "蓝色米底", keep: ["白底"] });
});

test.each(["七颗纽扣", "7颗纽扣", "seven buttons", "twenty-four petals", "二十四瓣", "一百二十颗纽扣", "缝线间距3mm", "宽三厘米"])("model-observed %s cannot become an unconfirmed lock", value => {
    expect(() => resolveImageAgentWorkNote(undefined, undefined, [value], "只改背景")).toThrow("未经用户确认");
    expect(resolveImageAgentWorkNote(undefined, undefined, [value], `保留${value}`).keep).toEqual([value]);
});

test("existing confirmed dimensions and English/Chinese counts retain equivalent values", () => {
    expect(resolveImageAgentWorkNote({ summary: "", keep: ["七颗纽扣", "间距3mm"] }, undefined, ["seven buttons", "间距3mm"], "背景改米色").keep).toEqual(["seven buttons", "间距3mm"]);
    expect(resolveImageAgentWorkNote(undefined, undefined, ["twenty-four petals"], "保留二十四瓣").keep).toEqual(["twenty-four petals"]);
    expect(resolveImageAgentWorkNote(undefined, undefined, ["one hundred and twenty buttons"], "保留一百二十颗纽扣").keep).toEqual(["one hundred and twenty buttons"]);
    expect(resolveImageAgentWorkNote(undefined, undefined, ["宽3cm"], "宽三厘米").keep).toEqual(["宽3cm"]);
});

test("a confirmed document card's unknown count is not evidence for a numeric lock", () => {
    const requirements = { title: "衬衫", subject: "衬衫", colors: "蓝色", materials: "棉", must: [], avoid: [], unknowns: ["是否七颗纽扣？"], documentIds: ["doc"], referenceFigureIds: [], sources: [] };
    const args = { prompt: "改蓝色", keep: ["七颗纽扣"] };
    const options = { catalog: images, selectedImageId: "v2", previewedImageIds: images.map(image => image.id), userPrompt: "改蓝色", requirements };
    expect(() => parseCreativeChatPlan(call(args), images, options)).toThrow("未经用户确认");
    expect(parseCreativeChatPlan(call(args), images, { ...options, requirements: { ...requirements, must: ["七颗纽扣"] } })).toMatchObject({ workNote: { keep: ["七颗纽扣"] } });
});

test("revocations survive JSON recovery without silently truncating locks or explicit reinstatement", () => {
    const note = resolveImageAgentWorkNote({ summary: "状态".repeat(500), keep: ["白底", "版型"] }, undefined, undefined, imageAgentKeepRevocationDraft("背景改米色", "白底"));
    const restored = JSON.parse(JSON.stringify(note));
    expect(resolveImageAgentWorkNote(restored, undefined, ["白底", "版型"], "改袖口").keep).toEqual(["版型"]);
    expect(restored.revokedKeep).toEqual(["白底"]);
    expect(() => resolveImageAgentWorkNote({ summary: "", keep: [], revokedKeep: ["字".repeat(800)] }, undefined, undefined, "改色")).toThrow("不会截断");
});

test("chat original redo inherits current-branch effective locks and never revives a revoked original lock", () => {
    const options = { catalog: images, selectedImageId: "v2", previewedImageIds: images.map(image => image.id), userPrompt: "回原图，改成绿色" };
    const plan = parseCreativeChatPlan(call({ base: "original", prompt: "改成绿色", keep: ["蓝色", "白底"] }), images, options);
    expect(plan).toMatchObject({ parentId: "original", workNote: { keep: ["白底"], revokedKeep: ["蓝色"] } });
    if (plan.kind !== "image") throw new Error("expected image");
    expect(plan.references[0]?.dataUrl).toBe(images[0]!.dataUrl);
    expect(plan.prompt).not.toContain("蓝色");
    const branch = parseCreativeChatPlan(call({ base: "图1", prompt: "原始分支继续" }), images, { ...options, userPrompt: "原始分支继续" });
    expect(branch).toMatchObject({ workNote: { keep: ["蓝色", "白底"] } });
});

test("canvas current-turn cancellation beats both inherited locks and repeated planner locks on original redo", () => {
    const catalog = images.map(image => ({ ...image, reference: { id: image.id, title: image.name, type: CanvasNodeType.Image, dataUrl: image.dataUrl } }));
    const userPrompt = imageAgentKeepRevocationDraft("回原图，背景改米色", "白底");
    const edit = resolveCanvasImageAgentEdit({ base: "original", prompt: "背景改米色", keep: ["蓝色", "白底"] }, catalog, { focusId: "v2", userPrompt });
    expect(edit.base?.id).toBe("original");
    expect(edit.record.note.keep).toEqual([]);
    expect(edit.record.note.revokedKeep).toEqual(["蓝色", "白底"]);
    expect(edit.prompt).not.toContain("取消保留项");
    expect(edit.prompt).not.toContain("白底");
});

test("both shared UI states label cancellation as pending until the draft is sent", () => {
    const render = (draft: string) => renderToStaticMarkup(<ImageAgentKeepControls keep={["白底"]} draft={draft} onChange={() => { throw new Error("render cannot write"); }} />);
    expect(render("")).toContain("下轮取消");
    expect(render(imageAgentKeepRevocationDraft("改背景", "白底"))).toContain("待发送取消");
    expect(render("")).toContain("删除草稿则不生效");
    expect(render("")).not.toContain("已取消");
});
