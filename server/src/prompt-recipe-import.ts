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

/** Reads the supplied source as data. Only an explicit CLI/admin invocation persists it. */
export function parsePromptRecipeDocument(source: string): ImportedPromptRecipe[] {
  const base = rules(section(source, "## 一、"));
  const garmentColor = rules(section(source, "### 2.4 "));
  const entries: ImportedPromptRecipe[] = [];
  const add = (key: string, name: string, systemPrompt: string, outputLanguage: "en" | "zh" = "en") => entries.push({ key,
    settings: { name, enabled: true, modelConfigId: null, failurePolicy: "stop" },
    content: { systemPrompt: ["reverse-prompt", "creative-chat", "canvas-assistant"].includes(key) ? systemPrompt : `${systemPrompt}\n\n${imageOutputContract}`, fieldTemplate: "", modelOverrides: {}, fallbackPrompt: "", outputLanguage, changeNote: "从用户提供的板块系统提示词导入；跨章节规则已展开；明确空数组字段不可省略" },
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
