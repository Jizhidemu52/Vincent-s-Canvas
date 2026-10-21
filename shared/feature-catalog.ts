/** Formal product capabilities. No secrets or environment-specific model IDs belong here. */
export const toolDefinitions = [
  { toolKey: "image", label: "文生图", group: "AI 工作台", operationType: "image_generation", operations: ["image_generation", "inpaint"], capabilities: ["generate"], parent: null },
  { toolKey: "detail-enhance", label: "细节增强", group: "AI 工作台", operationType: "upscale", operations: ["upscale"], capabilities: ["upscale", "edit"], parent: null },
  { toolKey: "image-edit", label: "图片编辑", group: "AI 工作台", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: null },
  { toolKey: "angle-control", label: "角度控制", group: "AI 工作台", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: null },
  { toolKey: "seamless-stitch", label: "无缝拼接", group: "AI 工作台", operationType: "seamless_stitch", operations: ["seamless_stitch"], capabilities: ["edit"], parent: null },
  { toolKey: "midjourney-blend", label: "MJ 多图融合", group: "AI 工作台", operationType: "image_generation", operations: ["image_generation"], capabilities: ["generate"], parent: null },
  { toolKey: "video", label: "视频创作", group: "AI 工作台", operationType: "video_generation", operations: ["video_generation"], capabilities: ["video"], parent: null },
  { toolKey: "creative-text-to-style", label: "以文生款", group: "创意工具", operationType: "image_generation", operations: ["image_generation", "inpaint"], capabilities: ["generate"], parent: "creative" },
  { toolKey: "creative-style-to-sketch", label: "款生线稿", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-local-restyle", label: "局部改款", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-garment-colorway", label: "服装配色", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-back-design", label: "背面设计", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-pattern-extract", label: "花型提取", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-pattern-colorway", label: "图案配色", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-accessory-design", label: "辅料设计", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-pattern-craft", label: "图案工艺", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-series-extension", label: "系列拓款", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-bestseller-proposal", label: "爆款提案", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-detail-to-style", label: "细节生款", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-fabric-to-style", label: "面料生款", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-reference-to-style", label: "参考生款", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-style-fusion", label: "款式融合", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-outfit-design", label: "穿搭设计", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-apply-pattern", label: "贴图案", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-pattern-fill", label: "填面料", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-fabric-change", label: "换面料", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-remove-decoration", label: "去装饰", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-sketch-to-style", label: "线稿生款", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-pattern-create", label: "AI 图案", group: "创意工具", operationType: "image_generation", operations: ["image_generation", "inpaint"], capabilities: ["generate", "edit"], parent: "creative" },
  { toolKey: "creative-pattern-fusion", label: "图案融合", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-seamless-pattern", label: "四方连续", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "creative-pattern-layers", label: "图案分层", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "series-recipe", label: "系列配方", group: "创意工具", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "creative" },
  { toolKey: "canvas-image", label: "画布图片生成", group: "无线画布", operationType: "image_generation", operations: ["image_generation"], capabilities: ["generate"], parent: "canvas" },
  { toolKey: "canvas-edit", label: "画布图片编辑", group: "无线画布", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "canvas" },
  { toolKey: "canvas-mask-edit", label: "画布局部蒙版编辑", group: "无线画布", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "canvas" },
  { toolKey: "canvas-angle", label: "画布角度编辑", group: "无线画布", operationType: "inpaint", operations: ["inpaint"], capabilities: ["edit"], parent: "canvas" },
  { toolKey: "canvas-batch", label: "画布批量改图", group: "无线画布", operationType: "batch_image", operations: ["batch_image"], capabilities: ["batch", "edit"], parent: "canvas" },
  { toolKey: "canvas-chat", label: "画布 Agent / 文字与反推", group: "无线画布", operationType: "chat", operations: ["chat"], capabilities: ["chat"], parent: "canvas" },
  { toolKey: "canvas-video", label: "画布视频生成", group: "无线画布", operationType: "video_generation", operations: ["video_generation"], capabilities: ["video"], parent: "canvas" },
  { toolKey: "canvas-audio", label: "画布音频生成", group: "无线画布", operationType: "audio_generation", operations: ["audio_generation"], capabilities: ["audio"], parent: "canvas" },
  { toolKey: "gpt-chat", label: "对话改图", group: "对话", operationType: "chat", operations: ["chat"], capabilities: ["chat"], parent: null },
  { toolKey: "gpt-chat-image", label: "对话生图与连续改图", group: "对话", operationType: "image_generation", operations: ["image_generation", "inpaint"], capabilities: ["generate", "edit"], parent: "gpt-chat" },
] as const;

export type ToolKey = (typeof toolDefinitions)[number]["toolKey"];
export const nonAiDefinitions = [
  { moduleKey: "creative", label: "创意工具总入口", group: "创意工具", kind: "group", description: "管理创意设计场景及创意本地工具的总入口", parent: null },
  { moduleKey: "canvas", label: "无线画布总入口", group: "无线画布", kind: "group", description: "管理画布入口；子能力可分别设置", parent: null },
  { moduleKey: "standard-colors", label: "标准色库 / 近似色搜索", group: "创意本地工具", kind: "local", description: "标准色查询、近似色搜索；本地数据，无需 API", parent: "creative" },
  { moduleKey: "photo-color-picker", label: "照片取色", group: "创意本地工具", kind: "local", description: "从照片提取色值与配色；本地执行，无需 API", parent: "creative" },
  { moduleKey: "pattern-recolor", label: "图案精确换色", group: "创意本地工具", kind: "local", description: "按色值和选区确定性换色；无需模型", parent: "creative" },
  { moduleKey: "svg-trace", label: "SVG 描摹", group: "创意本地工具", kind: "local", description: "位图描摹与 SVG 导出；本地执行，无需 API", parent: "creative" },
  { moduleKey: "creative-sketch-vectorization", label: "线稿矢量化", group: "创意本地工具", kind: "local", description: "线稿描摹与 SVG 导出；本地执行，无需 API", parent: "creative" },
  { moduleKey: "creative-pattern-vectorization", label: "图案矢量化", group: "创意本地工具", kind: "local", description: "彩色图案描摹与 SVG 导出；本地执行，无需 API", parent: "creative" },
  { moduleKey: "creative-selection", label: "选区绘制", group: "创意本地工具", kind: "local", description: "手绘编辑范围；本地工具，AI 生成另按对应场景配置", parent: "creative" },
  { moduleKey: "pattern-placement", label: "图案定位", group: "创意本地工具", kind: "local", description: "图案位置、比例、图层、二维合成和工程导出；无需 API，不是 AI 面料融合", parent: "creative" },
  { moduleKey: "pattern-repeat", label: "花型循环", group: "创意本地工具", kind: "local", description: "直排、半落、镜像循环和物理尺寸导出；本地几何铺排，无需 API", parent: "creative" },
  { moduleKey: "canvas-local-tools", label: "画布本地设计工具", group: "无线画布", kind: "local", description: "对比检查、手动编辑、裁剪、拆分、本地放大、排版、款式组与模板；无需 API，已有作品下载和备份导出始终保留", parent: "canvas" },
  { moduleKey: "canvas-local-agent", label: "本机 Agent", group: "无线画布", kind: "external", description: "连接本机 Codex bridge；模型在本机配置，不使用网站 Provider", parent: "canvas" },
  { moduleKey: "assets", label: "素材库", group: "资源与协作", kind: "service", description: "素材上传与管理；无需模型，关闭不删除数据", parent: null },
  { moduleKey: "prompts", label: "提示词库 / 我的提示词", group: "资源与协作", kind: "service", description: "提示词保存与复用；无需单独 API", parent: null },
  { moduleKey: "reference-import", label: "网页参考采集", group: "资源与协作", kind: "service", description: "公开网页参考采集；无需模型，仍遵循来源与访问限制", parent: null },
  { moduleKey: "design-library", label: "公司设计分享", group: "资源与协作", kind: "service", description: "公司设计分享库；无需模型，仍需企业身份与权限", parent: null },
  { moduleKey: "team", label: "我的小组", group: "资源与协作", kind: "service", description: "小组看板；仍遵循角色与部署限制", parent: null },
  { moduleKey: "performance", label: "设计效能", group: "资源与协作", kind: "service", description: "设计效能与成本看板；仍遵循角色与部署限制", parent: null },
] as const;

export const moduleDefinitions = [
  ...nonAiDefinitions,
  ...toolDefinitions.map((tool) => ({ moduleKey: tool.toolKey, label: tool.label, group: tool.group, kind: "ai" as const, parent: tool.parent, description: tool.operationType === "chat" ? "模型由后台“对话改图”统一指定；本板块开关与费用独立，积分总开关关闭时不扣分" : "独立模型绑定与开关；可设置本板块费用覆盖，积分总开关关闭时不扣分" })),
];
export type ModuleKey = (typeof moduleDefinitions)[number]["moduleKey"];
export const moduleKeys = moduleDefinitions.map((item) => item.moduleKey) as [ModuleKey, ...ModuleKey[]];

export function getToolDefinition(key: string | undefined | null) {
  return toolDefinitions.find((item) => item.toolKey === key);
}

export function moduleIsEnabled(flags: Partial<Record<ModuleKey, boolean>>, key: ModuleKey): boolean {
  const definition = moduleDefinitions.find((item) => item.moduleKey === key);
  return flags[key] === true && (!definition?.parent || flags[definition.parent] === true);
}

/** Only known legacy labels are normalized; unknown explicit keys remain invalid. */
export function resolveToolKey(operationType: string, key?: string | null): ToolKey | undefined {
  if (getToolDefinition(key)) return key as ToolKey;
  if (key === "image-generation") return "image";
  if (key === "agent-direct") return operationType === "inpaint" ? "canvas-edit" : "canvas-image";
  if (key) return undefined;
  const defaults: Record<string, ToolKey> = { image_generation: "image", inpaint: "image-edit", upscale: "detail-enhance", seamless_stitch: "seamless-stitch", video_generation: "video", audio_generation: "canvas-audio", batch_image: "canvas-batch", chat: "gpt-chat" };
  return defaults[operationType];
}
