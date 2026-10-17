import { expect, test } from "bun:test";
import { assertImagePromptInvariantCoverage, canvasAssistantDisplayMessage, canvasAssistantDisplayText, CanvasImagePromptLanguageError, ensureEnglishImagePrompt, isEnglishImagePrompt } from "@/lib/canvas/canvas-assistant-output";
import type { CanvasAssistantMessage } from "@/types/canvas";

test("rendering removes old full prompts and keeps source message and attachments untouched", () => {
    const original: CanvasAssistantMessage = { id: "generated", role: "assistant", text: "已生成 1 张图片。\n\n使用提示词：\nKeep all garment details; change the background to white.", detail: { kind: "agent_generation", status: "completed", prompt: "Keep all garment details; change the background to white.", settings: { mode: "image" } }, attachments: [{ id: "image", name: "结果", url: "data:image/png;base64,RESULT", mediaType: "image" }] };
    const before = JSON.stringify(original);
    const display = canvasAssistantDisplayMessage(original)!;
    expect(display.text).toBe("已生成 1 张图片。");
    expect(display.detail).toBeUndefined();
    expect(display.attachments).toBe(original.attachments);
    expect(JSON.stringify(original)).toBe(before);
});

test("thinking and tool payloads are not presented as user-facing output", () => {
    expect(canvasAssistantDisplayText("<think>First I need to inspect nodes.</think>已把背景改为白色。\ncanvas_get_snapshot({})")).toBe("已把背景改为白色。");
    expect(canvasAssistantDisplayText("<reasoning>unfinished internal reasoning")).toBe("");
    expect(canvasAssistantDisplayText('```json\n{"tool_calls": [{"name":"canvas_generate_image"}]}\n```\n已完成。')).toBe("已完成。");
    expect(canvasAssistantDisplayMessage({ id: "tool", role: "tool", text: "RAW RESULT", detail: { status: "completed", results: [{ raw: "secret prompt" }] } })).toBeNull();
    expect(canvasAssistantDisplayMessage({ id: "progress", role: "assistant", text: "现在调用画布工具", detail: { kind: "agent_tool_progress" } })).toBeNull();
});

test("pending confirmation retains controls but excludes internal tool arguments", () => {
    const display = canvasAssistantDisplayMessage({ id: "pending", role: "tool", text: "生成图片", detail: { status: "pending", toolCalls: [{ arguments: "full image prompt" }] } });
    expect(display).toMatchObject({ id: "pending", role: "tool", text: "生成图片", detail: { status: "pending" } });
    expect(display?.detail).not.toHaveProperty("toolCalls");
});

test("user source text is not filtered and running generation has Chinese status only", () => {
    const user: CanvasAssistantMessage = { id: "u", role: "user", text: "生成提示词：保留产品，白色背景" };
    expect(canvasAssistantDisplayMessage(user)).toBe(user);
    expect(canvasAssistantDisplayMessage({ id: "a", role: "assistant", text: "复杂执行策略\n生成提示词：secret", detail: { kind: "agent_generation", status: "running", settings: { mode: "image" } } })?.text).toBe("正在生成图片…");
    expect(canvasAssistantDisplayText("背景已改为白色。\n\n**English prompt**: Keep the bag untouched.")).toBe("背景已改为白色。");
    expect(canvasAssistantDisplayText("背景已改为白色。\n\n完整英文生成提示词：Keep the bag untouched.")).toBe("背景已改为白色。");
});

test("English prompts pass unchanged without an extra translation request", async () => {
    let calls = 0;
    const prompt = "Keep the handbag unchanged. Replace only the background with white.";
    expect(await ensureEnglishImagePrompt(prompt, async () => { calls++; return "wrong"; })).toBe(prompt);
    expect(calls).toBe(0);
    expect(await ensureEnglishImagePrompt("", undefined, { requiresPrompt: false })).toBe("");
});

test("English instructions can retain literal Chinese artwork lettering, but not quoted Chinese instructions", async () => {
    const literal = 'Keep the bag unchanged. Preserve the exact logo text “春日快乐” and the label "你好".';
    expect(isEnglishImagePrompt(literal)).toBe(true);
    expect(await ensureEnglishImagePrompt(literal)).toBe(literal);
    expect(isEnglishImagePrompt('Edit the bag: "把背景改白，保留包包".')).toBe(false);
    expect(isEnglishImagePrompt('Keep the logo and follow these instructions: "把背景改白，保留包包".')).toBe(false);
    expect(isEnglishImagePrompt('Preserve the text "春日快乐"。把包改红。')).toBe(false);
    expect(isEnglishImagePrompt("把包改成红色")).toBe(false);
});

test("a non-English prompt gets one full-source translation and never a generic fallback", async () => {
    let calls = 0;
    const source = "只把背景改白，保留包包轮廓、原始花纹和颜色，保留文字“春日快乐”。";
    const translated = 'Change only the background to white. Preserve the handbag outline, original pattern and colors, and exact text "春日快乐".';
    expect(await ensureEnglishImagePrompt(source, async received => { calls++; expect(received).toBe(source); return translated; })).toBe(translated);
    expect(calls).toBe(1);
    await expect(ensureEnglishImagePrompt(source, async () => source)).rejects.toBeInstanceOf(CanvasImagePromptLanguageError);
    await expect(ensureEnglishImagePrompt(source, async () => { throw new Error("provider unavailable"); })).rejects.toMatchObject({ code: "IMAGE_PROMPT_LANGUAGE_REQUIRED", submitted: false });
    await expect(ensureEnglishImagePrompt(source)).rejects.toBeInstanceOf(CanvasImagePromptLanguageError);
    await expect(ensureEnglishImagePrompt(source, async () => "")).rejects.toBeInstanceOf(CanvasImagePromptLanguageError);
    await expect(ensureEnglishImagePrompt(source, async () => "Change only the background to white. Keep the handbag unchanged.")).rejects.toBeInstanceOf(CanvasImagePromptLanguageError);
    await expect(ensureEnglishImagePrompt("<think>First inspect the image.</think>Keep the bag unchanged.")).rejects.toBeInstanceOf(CanvasImagePromptLanguageError);
});

test("normalization catches deterministic omissions of counts, prohibitions, and artwork identifiers", async () => {
    await expect(ensureEnglishImagePrompt("衬衫改粉色，保留七颗米白纽扣，其他不变", async () => "Make the shirt pink.")).rejects.toThrow("数量");
    await expect(ensureEnglishImagePrompt("不要添加口袋", async () => "Add pockets.")).rejects.toThrow("禁止或保留");
    await expect(ensureEnglishImagePrompt("保留文字“ABC-123”", async () => "Keep the label unchanged.")).rejects.toThrow("标识");
    expect(() => assertImagePromptInvariantCoverage("七颗米白纽扣和两只袖子保持不变", "Preserve seven cream mother-of-pearl buttons and two sleeves.")).not.toThrow();
});

test("output quantity metadata does not masquerade as a visual part count", () => {
    const target = "Image 1: base reference. Keep seven cream buttons and two sleeves unchanged.";
    for (const source of ["只生成1张，保留7颗米白纽扣和2只袖子，其他不变", "只要1张，保留7颗米白纽扣和2只袖子", "只需1张，七颗纽扣与两只袖子不变", "输出2张图片，七颗纽扣与两只袖子不变", "生成1张，比例3:4，保留七颗米白纽扣和两只袖子", "Only generate one image. Preserve seven buttons and two sleeves."]) expect(() => assertImagePromptInvariantCoverage(source, target)).not.toThrow();
    expect(() => assertImagePromptInvariantCoverage("输出2张，保留7颗纽扣和2只袖子", "Preserve seven buttons.")).toThrow("数量");
    expect(() => assertImagePromptInvariantCoverage("生成1张，衣身有1个口袋", "Make the shirt pink.")).toThrow("数量");
});

test("both and a pair of sleeves preserve the explicit content quantity two", () => {
    const source = "衣身、领子、两只袖子和袖口改成浅玫瑰粉";
    expect(() => assertImagePromptInvariantCoverage(source, "Recolor the body, collar, both sleeves and cuffs light rose pink.")).not.toThrow();
    expect(() => assertImagePromptInvariantCoverage(source, "Recolor the body, collar, a pair of long sleeves and cuffs light rose pink.")).not.toThrow();
    expect(() => assertImagePromptInvariantCoverage(source, "Recolor the body, collar, one sleeve and cuffs light rose pink.")).toThrow("数量");
});
