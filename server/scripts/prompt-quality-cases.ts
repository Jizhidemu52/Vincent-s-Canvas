/** Synthetic, non-confidential business fixtures. No API calls or private authoring rules. */
import type { PromptInputData, PromptScene } from "../../shared/prompt-contracts";
export type SceneForm = Record<string, unknown> & { description: string };
export type SceneAdapter = { createSceneForm: (scene: string) => SceneForm; scenePromptInput: (scene: string, form: SceneForm) => PromptInputData };

export const qualityAssets = {
  shirt: { path: "labs/design-workbench/assets/garment.png", description: "浅蓝色短袖衬衫，五颗可见前中纽扣，无口袋；已人工查看" },
  flat: { path: "output/creative-api-test/source-shirt.png", description: "米色平面短袖衬衫，五颗纽扣、单胸袋；已人工查看" },
  flower: { path: "output/designer-manual-20261021/revision-v2/assets/flower.png", description: "透明底珊瑚色六瓣花、黄色花心；已人工查看" },
  leaf: { path: "output/designer-manual-20261021/revision-v2/assets/leaf.png", description: "透明底绿色枝叶；已人工查看" },
  knit: { path: "output/designer-manual-20261021/revision-v2/assets/pattern-original.png", description: "奶油、海军蓝、芥末、砖红几何针织裁片；已人工查看" },
  button: { path: "output/designer-manual-20261021/revision-v2/assets/button-original.png", description: "72×72 棕色纽扣与针织底布；低分辨率限制，已人工查看" },
  buttonFour: { path: "output/designer-manual-20261021/revision-v2/assets/accessory.webp", description: "1024×1024 四孔圆形纹样纽扣，棕色边沿与浅色布背景；以前 QA 生成素材，不是实物生产证据；已人工查看" },
  buttonTwo: { path: "output/mark-provider-live/accessory-design-knit-A-1.png", description: "1024×1024 两孔圆形纹样纽扣，棕色边沿与白色背景；以前 QA 生成素材，不是实物生产证据；已人工查看" },
} as const;
export type QualityAssetKey = keyof typeof qualityAssets;
export type QualityCase = {
  id: string; group: "creative" | "workflow" | "template" | "series" | "batch" | "reverse" | "free" | "chat" | "protocol";
  label: string; sources: QualityAssetKey[]; toolKey: string; prompt: string; input?: PromptInputData;
  form?: SceneForm; pairId?: string; variant?: "old" | "new" | "off" | "on";
  checks: string[]; kind?: "batch" | "compile-only" | "chat";
  profile?: "creative-chat" | "canvas-assistant"; requestedModelId?: string;
  parameters?: Record<string, unknown>; operationType?: "inpaint" | "image_generation";
};
type OldBuilder = (scene: string, form: SceneForm) => string;
const common = ["主体与参考图职责正确", "仅改变明确要求的内容", "没有无关文字、水印、额外产品或部件", "真实材质与光影没有凭空改变"];
const source = (i: number): QualityAssetKey => i % 2 ? "flat" : "shirt";
const palettes = [["#2E5B4E", "#E8DCC8"], ["#253746", "#B76E55"], ["#A6B6C2", "#EFE5D6"], ["#D8A0A8", "#5E6B52"]];

/** 90 business/stability samples, including repeated briefs, each emitted as an old/new pair. */
export function creativeQualityCases(buildOld: OldBuilder, { createSceneForm, scenePromptInput }: SceneAdapter): QualityCase[] {
  const output: QualityCase[] = [];
  const add = (scene: PromptScene, i: number, patch: Partial<SceneForm>, sources: QualityAssetKey[], checks: string[]) => {
    const form = { ...createSceneForm(scene), ...patch };
    const pairId = `${scene}-${String(i + 1).padStart(2, "0")}`;
    const plain = buildOld(scene, form);
    const old = sources.length ? `参考图片编号：${sources.map((_, index) => `图片${index + 1}`).join("、")}。请按这些编号理解提示词中的图片引用。\n\n${plain}` : plain;
    for (const variant of ["old", "new"] as const) output.push({ id: `${pairId}-${variant}`, pairId, variant, group: "creative", label: `${scene} / ${i + 1} / ${variant}`,
      sources, form, prompt: variant === "old" ? old : form.description,
      toolKey: variant === "new" ? `creative-${scene}` : sources.length ? "image-edit" : "image",
      ...(variant === "new" ? { input: scenePromptInput(scene, form) } : {}), checks: [...common, ...checks] });
  };
  const concepts = [
    ["奶油色小尖领长袖衬衫，前中五颗纽扣，无口袋", "上衣", "微宽松", "棉府绸"],
    ["麻灰色圆领直身短袖T恤，左胸小字 INCHOICE，无口袋", "上衣", "按描述判断", "棉平纹针织"],
    ["海军蓝V领无袖背心，简洁罗纹下摆", "针织衫", "合体", "细针棉针织"],
    ["鼠尾草绿短款翻领夹克，两只贴袋", "外套", "宽松", "棉斜纹"],
    ["浅蓝色长袖连衣裙，小圆领，收腰，及膝", "连衣裙", "A 字型", "棉麻混纺"],
    ["砖红色圆领套头卫衣，落肩，无抽绳", "上衣", "宽松", "棉毛圈"],
    ["米白色阔腿长裤，松紧腰，无印花", "下装", "按描述判断", "亚麻"],
    ["深灰色直筒及膝半裙，单侧小开衩，无口袋", "下装", "按描述判断", "哑光梭织"],
    ["粉蓝条纹短袖衬衫，开领，直下摆", "上衣", "箱型", "轻薄棉布"],
    ["奶油黄圆领针织开衫，前中纽扣，长袖", "针织衫", "微宽松", "细针棉针织"],
  ];
  concepts.forEach(([description, category, silhouette, fabric], i) => add("text-to-style", i, { description, category, silhouette, fabric }, [], ["类别、廓形与面料符合字段", "完整单款白底平铺", ...(i === 1 ? ["INCHOICE 文字可读且不增加其他字样"] : [])]));
  for (let i = 0; i < 10; i++) {
    add("style-to-sketch", i, { sketchStyle: i % 2 ? "minimal" : "technical", sketchDetail: i % 3 ? "standard" : "detailed", description: i < 5 ? "只画正面，保留实际可见五颗纽扣；不增加口袋或装饰。" : "保留原图真实的领型、袖口、门襟和下摆轮廓；不要推断看不见的缝线。" }, [source(i)], ["原图可见纽扣数量保留", source(i) === "shirt" ? "无口袋，不新增口袋" : "原有单胸袋保留", "不能把栅格线稿称作生产纸样"]);
    const areas = ["领口", "袖子", "口袋", "其他", "下摆"];
    const changes = ["普通翻领改为柔和圆角领，不加花边", "短袖袖口加一条窄折边", "左胸增加一只小方形贴袋", "只把纽扣改为同尺寸深棕色圆扣", "直下摆改为浅弧形下摆"];
    add("local-restyle", i, { restyleArea: areas[i % 5], change: changes[i % 5], preserve: "保留衣身其余部分、原色、面料、比例与背景", description: i > 4 ? "所有未指定区域保持原样。" : "" }, [source(i)], ["修改限定在指定部位", "无真实 mask 的样本不能宣称区域外像素完全一致", "连接处结构与光影合理"]);
    const colorMode = (["smart", "specific", "reference"] as const)[i % 3]!;
    add("garment-colorway", i, { colorMode, colors: palettes[i % 4]!, colorRegion: i % 2 ? "仅衣身大身面料，袖子与领子保留原色" : "全部服装面料，纽扣保持原色", colorMood: ["自然柔和", "清爽明亮", "沉稳经典"][i % 3]!, description: "保持版型、缝线、纽扣、面料肌理及背景。" }, colorMode === "reference" ? [source(i), "knit"] : [source(i)], ["仅指定区域改色", "色参考不能带入针织纹样或其他款式", "HEX 仅视觉方向，不承诺生产色差"]);
    add("back-design", i, { backStructure: ["简洁", "育克", "中缝", "自由描述", "简洁"][i % 5]!, backMotif: i % 2 ? "延续风格" : "不延续", description: i % 5 === 3 ? "背面中上部一道横向育克，下方一处细褶，除此之外保持简洁。" : "匹配正面长度、肩宽、材质与配色，不把前门襟照搬到背部。" }, [source(i)], ["背面朝向明确", "正面纽扣不得复制到背面", "背面为推演，不声称观察到真实背面"]);
    const motif = (["flower", "leaf", "knit"] as const)[i % 3]!;
    add("pattern-extract", i, { extractMode: i % 2 ? "完整可见花型" : "单独图案", extractBackground: i % 3 ? "白底" : "保留底色", description: "保留清晰可见的形状、颜色、边缘与相对比例，不增添原图没有的元素。" }, [motif], ["不残留服装轮廓或拍摄背景", "不自动创造无缝循环、矢量路径或被遮挡图案", "背景与所选字段一致，保留底色时不擅自换白底"]);
    add("pattern-colorway", i, { colorMode, colors: palettes[(i + 1) % 4]!, colorRegion: i % 2 ? "仅图案主体，透明背景保持透明" : "图案的所有色块", colorMood: "自然柔和", description: "温暖低饱和秋季配色。保留图案轮廓、所有元素数量、位置、比例和排列。" }, colorMode === "reference" ? [motif, "flat"] : [motif], ["不能漂移图案形状或元素数量", "配色参考只取颜色", "透明背景与原排列保留"]);
    add("accessory-design", i, { accessoryType: "钮扣", accessoryApply: i % 2 ? "仅表面纹样" : "形状与纹样", description: i % 2 ? "只将图片2图案装饰到图片1纽扣表面，保留原外形及实际可见孔位。" : "将图片2轮廓应用到图片1纽扣外缘，保持纽扣连接功能与原材质观感。" }, [i < 2 ? "button" : i % 2 ? "buttonFour" : "buttonTwo", i % 3 ? "flower" : "leaf"], ["图片1提供辅料结构、图片2提供图案", "表面模式不改变轮廓", "不凭空增加拉链、链条或孔位", i < 2 ? "72px 参考只作低质输入压力测试，不进入主视觉结论" : "保留实际可见两孔或四孔，不依据模糊推测重做孔位", "生成素材不能宣称尺寸或开模可行性"]);
    add("pattern-craft", i, { craft: ["刺绣", "提花", "毛巾绣", "胶印"][i % 4]!, craftFabric: ["棉布", "针织面料", "帆布"][i % 3]!, description: "图案保持原有颜色、形状与比例，只模拟指定工艺；不添加其他装饰。" }, [motif], ["工艺表面纹理与字段一致", "原图案身份、形状与配色保留", "不是针迹文件或提花组织图"]);
  }
  return output;
}

export function auxiliaryQualityCases(): QualityCase[] {
  const cases: QualityCase[] = [];
  const add = (item: Omit<QualityCase, "checks"> & { checks?: string[] }) => cases.push({ ...item, checks: [...common, ...(item.checks ?? [])] });
  const workflows = [
    ["white_bg", "去除背景，保留完整服装，纯白背景"], ["recolor", "仅将衣身面料改成海军蓝，其他部分保留"],
    ["on_model", "成年模特正面穿着该款，摄影棚全身照"], ["detail_shot", "领口和前中纽扣近景，保留真实结构"],
    ["scene", "该款平整陈列在浅木色桌面上，自然柔光"], ["custom", "只把五颗纽扣改成同尺寸奶油白色"],
  ];
  for (const [type, prompt] of workflows) for (let i = 0; i < 2; i++) add({ id: `workflow-${type}-${i + 1}`, group: "workflow", label: `工作流 ${type} / ${i + 1}`, sources: [source(i)], toolKey: "canvas-edit", prompt: prompt!, input: { scene: "workflow-step", fields: { step_type: type, instruction: prompt }, userText: prompt, referenceRoles: ["上游步骤输出图"], mode: "edit" }, checks: ["与六类工作流对应", "这里只验单步 API，完整串行节点链路需浏览器验收"] });
  const templates: Array<[string, number, PromptScene, string]> = [
    ["development", 0, "style-to-sketch", "正面与背面技术线稿"], ["development", 1, "garment-colorway", "服装主体海军蓝，白底正面"], ["development", 2, "garment-presentation", "成人模特，正面全身，摄影棚"],
    ["print", 0, "print-placement", "胸前简洁原创植物印花"], ["print", 1, "pattern-craft", "胸前小型原创植物绣花"], ["print", 2, "garment-presentation", "胸前简洁原创植物装饰，纯净背景"],
    ["range", 0, "garment-colorway", "奶油白，正面平铺，白底"], ["range", 1, "garment-colorway", "海军蓝，正面平铺，白底"], ["range", 2, "garment-colorway", "鼠尾草绿，正面平铺，白底"],
  ];
  for (const [templateId, branchIndex, scene, prompt] of templates) for (let i = 0; i < 2; i++) add({ id: `template-${templateId}-${branchIndex + 1}-${i + 1}`, group: "template", label: `模板 ${templateId} 分支 ${branchIndex + 1} / ${i + 1}`, sources: [source(i)], toolKey: "canvas-edit", prompt, input: { scene, fields: { templateId, branchIndex, title: prompt, instruction: prompt, ...(templateId === "development" && branchIndex === 0 ? { views: ["front", "back"] } : {}) }, userText: prompt, referenceRoles: ["参考款"], mode: "edit" }, checks: ["仅验证当前分支，模板仍应保持三个并行节点"] });
  for (let i = 0; i < 2; i++) {
    const prompt = i ? "把图二植物图案小尺寸放在图一左胸，保留款式结构" : "同款奶油、鼠尾草系列配色，保留版型与肌理";
    add({ id: `series-${i + 1}`, group: "series", label: `系列配方 / ${i + 1}`, sources: i ? ["shirt", "leaf"] : ["shirt"], toolKey: "series-recipe", prompt, input: { scene: "series-recipe", fields: { kind: i ? "pattern" : "structure", series: "自然植物系列", constraints: "保持廓形、裁片、缝线与辅料不变", prompt, count: 1, palette: [{ name: "奶油", hex: "#E8DCC8" }, { name: "鼠尾草", hex: "#789282" }], paletteStyle: "soft", positions: ["左胸，小尺寸"], variantIndex: 0, hasMotif: Boolean(i) }, userText: prompt, referenceRoles: i ? ["产品底图", "图案参考图"] : ["产品底图"], mode: "edit" } });
    add({ id: `reverse-${i + 1}`, group: "reverse", label: `反推提示词 / ${i + 1}`, kind: "compile-only", sources: [source(i)], toolKey: "canvas-edit", prompt: "", input: { scene: "reverse-prompt", fields: {}, userText: "", referenceRoles: ["待反推图片"], mode: "edit" }, checks: ["与真实入口一致：未指定 outputLanguage，配方默认英文 prompt、中文摘要", "反推内容与可见图像相符", "不能捏造隐藏结构、尺寸或品牌"] });
    for (const enabled of [false, true]) {
      const free = i ? "只将短袖衬衫面料改为鼠尾草绿，保留纽扣和背景" : "奶油色圆领短袖T恤，白底平铺，无口袋";
      add({ id: `free-${i + 1}-${enabled ? "on" : "off"}`, group: "free", label: `普通输入 / ${i + 1} / 优化${enabled ? "开" : "关"}`, variant: enabled ? "on" : "off", sources: i ? ["shirt"] : [], toolKey: i ? "image-edit" : "image", prompt: free, ...(enabled ? { input: { scene: "free-optimize" as const, fields: {}, userText: free, referenceRoles: i ? ["参考图1"] : [], mode: i ? "edit" as const : "generate" as const, outputLanguage: "zh" as const } } : {}), checks: ["关闭优化时不得发编译请求", "开启时最终提示词可见、可复制和可编辑；UI 需另验"] });
    }
    for (const profile of ["creative-chat", "canvas-assistant"] as const) add({ id: `chat-${profile}-${i + 1}`, group: "chat", label: `${profile} / ${i + 1}`, kind: "chat", profile, sources: [source(i)], toolKey: profile === "creative-chat" ? "gpt-chat" : "canvas-chat", prompt: i ? "只分析这件衬衫的可见结构和配色，不生成、不修改图片。" : "请把这件衬衫仅改为鼠尾草绿色，其他不变。", checks: [i ? "只分析时不得生成图片工具调用" : "生成计划使用正确原图和完整修改目标", "没有内部系统规则泄漏", "本 harness 只验聊天规划响应，不执行返回的工具"] });
  }
  for (const enabled of [false, true]) add({ id: `batch-${enabled ? "on" : "off"}`, group: "batch", label: `批量改图 / 优化${enabled ? "开" : "关"}`, kind: "batch", variant: enabled ? "on" : "off", sources: ["shirt", "flat"], toolKey: "canvas-batch", prompt: "只把每张服装的衣身改为海军蓝，保留各自版型、纽扣、口袋与背景", ...(enabled ? { input: { scene: "batch-optimize" as const, fields: {}, userText: "只把每张服装的衣身改为海军蓝，保留各自版型、纽扣、口袋与背景", referenceRoles: ["每个批次条目的独立原图"], mode: "edit" as const } } : {}), checks: ["优化开关默认关闭", "开启仅编译一个共享提示词，两个图片任务", "两图保留各自特征，不能混淆胸袋"] });
  return cases;
}

/** Additional ten pairs for the two inconclusive v1 scenes; no replay of old failures. */
export function extendedCreativeQualityCases(buildOld: OldBuilder, { createSceneForm, scenePromptInput }: SceneAdapter): QualityCase[] {
  const output: QualityCase[] = [];
  const sketchDetails = [
    "黑色中等线宽技术线稿，标出可见肩缝和袖窿线。", "细线简约线稿，不表现布面阴影。", "外轮廓稍粗、内部缝线细，线宽层级清楚。",
    "保留领片交叠与门襟，不添加被遮住的纽扣或缝线。", "清楚表现现有短袖袖口折边。", "只保留结构线和可见纽扣，不添加虚构装饰明线。",
    "可见四孔纽扣以简洁圆形孔位表示，半遮挡领扣保持半遮挡。", "清楚保留原有浅弧形下摆，不改成直下摆。",
    "保留原袖宽与肩斜，去掉摄影阴影和面料填色。", "简洁正面产品线描，衣身比例、开领角度和门襟位置不变。",
  ];
  const colors = ["#2E5B4E", "#253746", "#B76E55", "#9AAFC3", "#D8A0A8", "#5E6B52", "#D5C6A5", "#75677C", "#B3BDCF", "#A96054"];
  for (let i = 0; i < 10; i++) for (const scene of ["style-to-sketch", "garment-colorway"] as const) {
    const description = scene === "style-to-sketch"
      ? `只画一件正面，不画背面。保持五颗完整前中纽扣及领口半遮挡原扣，不增加或删减；无胸袋，不能加袋。${sketchDetails[i]}`
      : `只改指定区域至 ${colors[i]}。五颗前中纽扣及半遮挡领扣保持原浅蓝色；结构、可见缝线、面料肌理、白色背景和画面比例保持。`;
    const colorRegion = i < 5 ? "仅大身面料和前门襟；袖子、领子及全部纽扣保持原浅蓝色"
      : i < 8 ? "全部服装面料，包括袖子、领子和门襟，但所有纽扣保持原浅蓝色" : "仅两只袖子面料；大身、领子、门襟及全部纽扣保持原浅蓝色";
    const form = { ...createSceneForm(scene), description, ...(scene === "style-to-sketch"
      ? { sketchStyle: i % 2 ? "minimal" : "technical", sketchDetail: i % 3 ? "standard" : "detailed" }
      : { colorMode: "specific", colors: [colors[i]], colorRegion, colorMood: "严格按指定色彩方向" }) };
    const pairId = `${scene}-${i + 11}`;
    for (const variant of ["old", "new"] as const) output.push({ id: `${pairId}-${variant}`, pairId, variant, group: "creative", label: `${scene} / ${i + 11} / ${variant}`,
      sources: ["shirt"], form, prompt: variant === "old" ? `参考图片编号：图片1。请按这些编号理解提示词中的图片引用。\n\n${buildOld(scene, form)}` : description,
      toolKey: variant === "new" ? `creative-${scene}` : "image-edit", ...(variant === "new" ? { input: scenePromptInput(scene, form) } : {}),
      checks: [...common, "五颗完整前中纽扣与半遮挡领扣分别核对，不混淆计数", "无胸袋，不添加胸袋", scene === "style-to-sketch" ? sketchDetails[i]! : `${colorRegion}；目标 ${colors[i]}`] });
  }
  return output;
}
