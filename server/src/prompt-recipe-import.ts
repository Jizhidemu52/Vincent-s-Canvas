import type { PromptRecipeSettings, PromptRecipeVersionContent } from "../../shared/prompt-contracts";
import type { PromptRecipeStore } from "./prompt-recipe-store";

const sceneEntries = [
  ["2.1", "text-to-style", "以文生款"], ["2.2", "style-to-sketch", "款生线稿"], ["2.3", "local-restyle", "局部改款"],
  ["2.4", "garment-colorway", "服装配色"], ["2.5", "back-design", "背面设计"], ["2.6", "pattern-extract", "花型提取"],
  ["2.7", "pattern-colorway", "图案配色"], ["2.8", "accessory-design", "辅料设计"], ["2.9", "pattern-craft", "图案工艺"],
] as const;
function section(text: string, heading: string) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith(heading));
  if (start < 0) throw new Error(`缺少配方章节：${heading}`);
  const level = lines[start]!.match(/^#+/)![0].length;
  let end = start + 1;
  while (end < lines.length && !(new RegExp(`^#{1,${level}} `)).test(lines[end]!)) end++;
  return lines.slice(start + 1, end).join("\n");
}
function rules(text: string) {
  const blocks = [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map(match => match[1]!.trim());
  if (!blocks.length) throw new Error("配方章节缺少规则代码块");
  return blocks.join("\n\n");
}
export type ImportedPromptRecipe = { key: string; settings: PromptRecipeSettings; content: PromptRecipeVersionContent };
const imageOutputContract = "最终响应必须是单个严格 JSON 对象，且始终包含 prompt、avoid、keep_text 三个字段。prompt 必须是字符串；avoid 和 keep_text 必须是字符串数组，即使没有负向要求或需保留的文字，也必须分别输出空数组 []，不得省略字段。不要输出 Markdown 代码围栏或 JSON 之外的内容。";
const fidelityCorrections: Record<string, string> = {
  "pattern-extract": "提取保真纠偏（覆盖前文默认补全要求）：默认仅提取参考图中可见且有证据的图案；保持可见轮廓、裁切边界、元素数量和相对位置，不推测被遮挡或画外内容。单独图案也不等于补成完整对称单元。只有用户明确要求恢复或补全时才允许补全，并限制于其指定范围。完整可见花型不得重排元素。extractBackground=白底时使用纯白不透明背景；保留底色时保留主图原背景，包括真实透明度，不绘制棋盘格。",
  "pattern-craft": "工艺构图纠偏（覆盖前文默认微距、倾斜视角和浅景深要求）：默认完整保留参考图案的所有可见元素、轮廓、数量和相对位置，主体完整入镜，四边留出清晰背景边距，边缘与工艺细节均清晰。采用正视或轻微视角，不强制 macro、15–30度或 shallow depth of field；工艺质感在完整构图内呈现。仅用户明确要求局部特写时才允许相应裁切，不因工艺名称自行放大裁边。",
  "style-to-sketch": "线稿保真纠偏（覆盖默认规范化要求）：以参考图可见结构为依据，sketchStyle/sketchDetail 仅改变线条表现，不得借对称平铺新增部件、明线或补全遮挡。先核对纽扣、口袋、门襟等可见数量与位置，完整部件和半遮挡部件分开描述并保持遮挡比例；只画原图证据，不把半遮挡领扣删掉或补成另一颗完整纽扣。保留真实可见不对称。",
  "pattern-colorway": "配色保真纠偏：主图只允许改变指定色块的 RGB 颜色，轮廓、线宽、元素数量、位置、纹理与背景不可随配色重新设计。第二张参考图仅提供配色依据，不提供新的形状或背景。",
};
const transparentArtworkRule = "透明图案边缘约束（仅在保留主图透明背景时适用）：输出是无场景光照的二维图案，不是产品摄影。原图案外部保持完全透明，不能添加投影、发光、光晕、渐变雾边、彩色底衬或棋盘格；主体实色区域保持不透明，仅原本的抗锯齿边缘允许半透明。不得通过全图降低不透明度实现透明底。将这些具体视觉要求写入最终提示词。";

/** Reads the supplied source as data. Only an explicit CLI/admin invocation persists it. */
export function parsePromptRecipeDocument(source: string): ImportedPromptRecipe[] {
  const base = rules(section(source, "## 一、"));
  const garmentColor = rules(section(source, "### 2.4 "));
  const entries: ImportedPromptRecipe[] = [];
  const add = (key: string, name: string, systemPrompt: string, outputLanguage: "en" | "zh" = "en") => entries.push({ key,
    settings: { name, enabled: true, modelConfigId: null, failurePolicy: "stop" },
    content: { systemPrompt: ["reverse-prompt", "creative-chat", "canvas-assistant"].includes(key) ? systemPrompt : [systemPrompt, fidelityCorrections[key], ["pattern-extract", "pattern-colorway"].includes(key) ? transparentArtworkRule : "", "文字一致性：用户指定的印字必须逐字保留于 prompt 和 keep_text；此时 avoid 只能排除额外或无关文字，禁止用笼统 text/no text 抵消指定印字。", imageOutputContract].filter(Boolean).join("\n\n"), fieldTemplate: "", modelOverrides: {}, fallbackPrompt: "", outputLanguage, changeNote: "从用户原稿导入并保留原文件；展开跨章节规则；补充提取、工艺构图、线稿、透明边缘和指定文字保真纠偏及严格输出契约" },
  });
  for (const [number, key, name] of sceneEntries) {
    const own = rules(section(source, `### ${number} `));
    const dependency = key === "pattern-colorway" ? `\n\n以下为配色方式的完整参考规则，仅使用目标颜色的确定方式，主体仍为图案而非服装：\n${garmentColor}` : "";
    add(key, name, `${base}\n\n${own}${dependency}`);
  }
  add("series-recipe", "系列配方", `${base}\n\n${rules(section(source, "## 三、"))}`);
  add("workflow-step", "图片工作流步骤", `${base}\n\n${rules(section(source, "## 四、"))}\n\n以下补充仅在 step_type=recolor 时适用，其他步骤忽略：\n${garmentColor}`);
  const templateRules = rules(section(source, "## 五、"));
  const templateParts = templateRules.split("【板块：成衣展示】");
  if (templateParts.length !== 2) throw new Error("服装模板专用规则不完整");
  add("print-placement", "印花定位稿", `${base}\n\n${templateParts[0]}`);
  add("garment-presentation", "成衣展示", `${base}\n\n【板块：成衣展示】${templateParts[1]}`);
  add("free-optimize", "一键优化", `${base}\n\n${rules(section(source, "## 六、"))}\n\n服务端执行约定：使用指定 output_language 输出，所见即所发；不得要求额外隐藏翻译。本板块的篇幅限制优先于通用生成类词数下限。`, "zh");
  add("batch-optimize", "批量改图优化", `${base}\n\n${rules(section(source, "## 七、"))}`);
  add("reverse-prompt", "反推提示词", `${base}\n\n${rules(section(source, "## 八、"))}\n\n本板块的输出格式覆盖通用输出契约，只返回 prompt 和 summary_zh。`);
  const chatSupplement = rules(section(source, "## 九、"));
  add("creative-chat", "对话改图补充规则", chatSupplement);
  add("canvas-assistant", "画布助手补充规则", chatSupplement);
  return entries;
}

export async function importPromptRecipes(store: PromptRecipeStore, source: string, options: { actorId: string; modelConfigId?: string; activate?: boolean }) {
  const results = [];
  for (const entry of parsePromptRecipeDocument(source)) {
    const recipe = await store.ensure(entry.key, { ...entry.settings, modelConfigId: options.modelConfigId ?? null });
    const version = await store.saveVersion(entry.key, entry.content, options.actorId);
    // An import never overwrites a subsequently edited or activated version.
    if (options.activate && !recipe.currentVersionId) await store.activate(entry.key, version.id);
    results.push({ key: entry.key, version: version.version, id: version.id, contentHash: version.contentHash, activated: options.activate && !recipe.currentVersionId });
  }
  return results;
}
