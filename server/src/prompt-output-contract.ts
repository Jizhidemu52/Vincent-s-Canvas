/** Server-owned wire limits, shared by optimizer instructions and validation. */
export const imagePromptOutputLimits = {
  raw: 30_000,
  prompt: 20_000,
  avoidItems: 8,
  avoidItem: 500,
  keepTextItems: 50,
  keepTextItem: 1_000,
} as const;

// Keep this separate from editable recipe prose: already-installed recipes must
// tell the optimizer the same boundaries that the server will enforce.
export const imagePromptOutputContract = [
  "【服务端输出格式限制】只输出单个严格 JSON 对象，必须且只能包含 prompt、avoid、keep_text；不要 Markdown、解释或额外字段。",
  `prompt 必须是非空字符串，最多 ${imagePromptOutputLimits.prompt} 个字符。avoid 和 keep_text 必须为字符串数组；没有内容时输出 []，不能省略。`,
  `avoid 最多 ${imagePromptOutputLimits.avoidItems} 项，每项最多 ${imagePromptOutputLimits.avoidItem} 个字符；限制较多时合并同类项但不能丢弃任何必要的限制，也不能新增与本次编辑目标或保留要求冲突的限制。`,
  `keep_text 最多 ${imagePromptOutputLimits.keepTextItems} 项，每项必须为 1 至 ${imagePromptOutputLimits.keepTextItem} 个字符；只列出需保留的实际文字，并逐字保留在 prompt 中，不要把普通结构或材质约束写入 keep_text。`,
  `完整 JSON 最多 ${imagePromptOutputLimits.raw} 个字符，prompt 与追加的 avoid 合计最多 ${imagePromptOutputLimits.prompt} 个字符。`,
].join("\n");
