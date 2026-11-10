import type { Allocation, Group } from "./ledger";
import { defaultAllocation, validateAllocation } from "./ledger";
import { INITIAL_BATCH_ID, validateBatchId } from "./budget-extension";

export type Strategy = "raw" | "template" | "minimal" | "legacy";
export type Source = { path: string; role: string; provenance: string; approvedForEvaluation: boolean; fromAttempt?: string };
export type Sample = { id: string; label: string; scene: string; userText: string; fields: Record<string, unknown>; sources: Source[]; change: string[]; preserve: string[] };
export type Model = { key: string; modelConfigId: string; expectedModelId: string };
export type Config = {
  version: 1; apiOrigin: string; campaign: string; allocation: Allocation; models: Model[]; strategies: Strategy[];
  parameters: Record<string, unknown>; recipes: Record<string, Partial<Record<Exclude<Strategy, "raw">, { versionId: string; expectedExecutionStrategy: string; optimizerModelConfigId?: string }>>>;
  samples: Sample[]; sequenceSampleIds: string[]; approvedForPaidExecution: boolean;
};
export type Job = { key: string; group: Group; sample: Sample; model: Model; strategy: Strategy; round?: number; retryOf?: string };

const fixture = (name: string, role: string): Source => ({ path: `docs/manual/prompt-optimization/testing/fixtures/${name}`, role,
  provenance: "既有公开 QA 业务任务素材；prompt-quality-cases.ts 标注 Synthetic，不是公司真实实物/员工原图。", approvedForEvaluation: false });
const common = ["不增删未指定结构", "不新增背景、人物、水印或无关文字"];
export const candidateSamples: Sample[] = [
  { id: "garment-color", label: "整件指定改色", scene: "garment-colorway", userText: "将图片1衬衫的大身改成鼠尾草绿，领口、门襟、纽扣、袖口、轮廓、面料纹理和白色背景保持原样。", fields: { colorMode: "specific", colors: ["鼠尾草绿"], colorRegion: "衬衫大身" }, sources: [fixture("shirt.png", "图片1：待改色原衬衫")], change: ["仅衬衫大身改为鼠尾草绿；颜色名不推断为生产色号"], preserve: ["领口、门襟、纽扣、袖口、轮廓、纹理、白底", ...common] },
  { id: "collar-local", label: "局部领口改色", scene: "local-restyle", userText: "只把图片1衬衫领口改成海军蓝，领型不改，其余颜色、胸袋、纽扣数量、面料和背景都不变。", fields: { restyleArea: "领口", change: "只改为海军蓝，领型不改", preserve: "其他颜色、胸袋、纽扣数量、面料、背景" }, sources: [fixture("flat.png", "图片1：原衬衫")], change: ["领口颜色"], preserve: ["领型、其他颜色、胸袋、纽扣数量、面料、背景", "无实际 mask 不声称区域外像素一致", ...common] },
  { id: "technical-sketch", label: "款式线稿", scene: "style-to-sketch", userText: "将图片1转为白底黑线正面服装款式图，只画当前可见结构；不要补画背面、暗袋或不可见缝线。", fields: { sketchStyle: "technical", sketchDetail: "standard", description: "仅当前可见结构，不推断背面、暗袋或缝线" }, sources: [fixture("shirt.png", "图片1：可见结构唯一依据")], change: ["转为黑白线稿"], preserve: ["可见轮廓、领型、袖口、门襟和纽扣数量", ...common] },
  { id: "pattern-extract", label: "花型平面提取", scene: "pattern-extract", userText: "将图片1可见的完整几何针织图案提取到白色平面上，保持原有颜色、图形数量与相对位置，不新增看不到的纹样。", fields: { extractMode: "单独图案", extractBackground: "白底", description: "仅提取完整可见图案，不新增看不到的纹样" }, sources: [fixture("knit.png", "图片1：原花型与配色依据")], change: ["平面提取并置白底"], preserve: ["可见图案、数量、颜色、相对位置", ...common] },
  { id: "pattern-color", label: "花型指定配色", scene: "pattern-colorway", userText: "只把图片1图案中的砖红色块改为深绿色，其余颜色、几何形状、数量、比例和排列位置保持不变。", fields: { colorMode: "specific", colors: ["深绿"], colorRegion: "砖红色块", description: "只替换砖红色块" }, sources: [fixture("knit.png", "图片1：待改色花型")], change: ["砖红色块替换为深绿"], preserve: ["其他颜色、形状、数量、比例、位置", ...common] },
  { id: "flower-craft", label: "花型工艺效果", scene: "pattern-craft", userText: "把图片1花朵做成棉布上的平针刺绣效果，保留花瓣数量、轮廓、珊瑚色和黄色花心，不添加叶子、文字或装饰。", fields: { craft: "刺绣", craftFabric: "棉布", description: "平针刺绣，保留原花瓣数量、轮廓与配色" }, sources: [fixture("flower.png", "图片1：花朵造型与颜色依据")], change: ["平针刺绣材质效果"], preserve: ["花瓣数量、轮廓、配色", ...common] },
  { id: "print-placement", label: "多参考定位印花", scene: "local-restyle", userText: "在图片1衬衫左胸添加图片2原样的单朵花印花，图片2只提供花朵图案；不要加胸袋或改变衬衫的纽扣、轮廓、颜色和背景。", fields: { restyleArea: "左胸", change: "添加图片2单朵花印花", preserve: "图片1衬衫结构、纽扣、轮廓、颜色和背景" }, sources: [fixture("shirt.png", "图片1：原衬衫，保留结构"), fixture("flower.png", "图片2：仅提供花朵图案")], change: ["左胸添加单朵原样花图案"], preserve: ["衬衫结构与颜色；花图案不能变成新产品", ...common] },
  { id: "reference-color", label: "颜色参考职责", scene: "garment-colorway", userText: "仅把图片1衬衫大身换成图片2针织图案中的海军蓝；图片2只作颜色参考，不能带入几何图案或针织纹理。图片1的结构、纽扣和背景保持不变。", fields: { colorMode: "reference", colorRegion: "衬衫大身", description: "图片2仅供海军蓝颜色，不供图形和面料" }, sources: [fixture("shirt.png", "图片1：待修改服装与结构依据"), fixture("knit.png", "图片2：仅取海军蓝，不取图案与纹理")], change: ["衬衫大身海军蓝"], preserve: ["衬衫结构、纽扣、原面料、白底", ...common] },
  { id: "specified-text", label: "指定文字", scene: "local-restyle", userText: "在图片1左胸只添加一行文字 'SUMMER 2026'，大小适中，不加其他字。原胸袋、纽扣、衬衫颜色、轮廓和背景保持不变。", fields: { restyleArea: "左胸", change: "只加一行指定文字 SUMMER 2026", preserve: "胸袋、纽扣、衬衫颜色、轮廓和背景" }, sources: [fixture("flat.png", "图片1：原衬衫")], change: ["一行 SUMMER 2026，逐字符核对"], preserve: ["原胸袋、纽扣、颜色、轮廓、背景", ...common] },
  { id: "motif-combine", label: "多图组合", scene: "pattern-craft", userText: "将图片1花朵与图片2枝叶组合成一组棉布刺绣效果。保留两张图中的所有可见图形、数量和颜色，只调整整体排布，不复制出额外花朵或叶片。", fields: { craft: "刺绣", craftFabric: "棉布", description: "组合两图，保留各自图形、数量和颜色" }, sources: [fixture("flower.png", "图片1：全部花朵图形"), fixture("leaf.png", "图片2：全部枝叶图形")], change: ["两图组合排布与刺绣效果"], preserve: ["各图形身份、可见数量、配色", ...common] },
];

export function starterConfig(): Config {
  const recipes: Config["recipes"] = {};
  for (const sample of candidateSamples) recipes[sample.scene] = {
    template: { versionId: "FILL_TEMPLATE_VERSION_UUID", expectedExecutionStrategy: "template-first" },
    minimal: { versionId: "FILL_MINIMAL_VERSION_UUID", expectedExecutionStrategy: "minimal" },
    legacy: { versionId: "FILL_LEGACY_VERSION_UUID", expectedExecutionStrategy: "llm" },
  };
  return { version: 1, apiOrigin: "http://127.0.0.1:13100", campaign: "prompt-chain-100", allocation: { ...defaultAllocation },
    models: [{ key: "model-a", modelConfigId: "FILL_MODEL_A_UUID", expectedModelId: "FILL_MODEL_A_ID" }, { key: "model-b", modelConfigId: "FILL_MODEL_B_UUID", expectedModelId: "FILL_MODEL_B_ID" }],
    strategies: ["raw", "template", "minimal", "legacy"], parameters: { n: 1, size: "1:1", resolution: "1k" }, recipes,
    samples: structuredClone(candidateSamples), sequenceSampleIds: ["garment-color", "specified-text"], approvedForPaidExecution: false };
}
export function buildJobs(config: Config, maximumAllocation = 100): Job[] {
  validateAllocation(config.allocation, maximumAllocation);
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(config.campaign) || new Set(config.samples.map(s => s.id)).size !== config.samples.length
    || new Set(config.models.map(m => m.key)).size !== config.models.length || new Set(config.strategies).size !== config.strategies.length
    || config.strategies.some(strategy => !["raw", "template", "minimal", "legacy"].includes(strategy))) throw new Error("INVALID_PLAN");
  const jobs: Job[] = [];
  for (const sample of config.samples) for (const strategy of config.strategies) for (const model of config.models)
    jobs.push({ key: `${config.campaign}:${sample.id}:${strategy}:${model.key}`, group: "single", sample, model, strategy });
  for (const id of config.sequenceSampleIds) for (const model of config.models) {
    const original = config.samples.find(s => s.id === id); if (!original) throw new Error("SEQUENCE_SAMPLE_MISSING");
    if (!["garment-color", "specified-text"].includes(id)) throw new Error("SEQUENCE_REQUIRES_EXPLICIT_ROUND_BRIEFS");
    const briefs = id === "garment-color" ? [original.userText,
      "在上一轮图上，只将领口改为海军蓝，保持鼠尾草绿大身以及其他结构和背景不变。",
      "回到最初的原图重做，只将衬衫大身改为砖红色；领口沿用原图颜色，不保留上一轮海军蓝领口，其他内容不变。"] : [original.userText,
      "在上一轮图上，只将左胸文字 SUMMER 2026 改为 SUMMER 2027；字体大小、位置、胸袋、纽扣、衣身颜色和背景不变。",
      "在上一轮图上移除左胸 SUMMER 2027 文字，恢复该处衣身面料；胸袋、纽扣、轮廓、颜色和背景不变。"];
    for (let round = 1; round <= 3; round++) {
      const key = `${config.campaign}:sequence:${id}:${model.key}:${round}`;
      const reset = id === "garment-color" && round === 3;
      const sources = round === 1 || reset ? structuredClone(original.sources) : [{ ...original.sources[0]!, role: "图片1：上一轮已保存原始结果", fromAttempt: `${config.campaign}:sequence:${id}:${model.key}:${round - 1}` }];
      const userText = briefs[round - 1]!;
      // Later rounds have their own fields, never carry the original round's change into a new instruction.
      const sample = { ...original, scene: "local-restyle", userText, sources, fields: { change: userText, preserve: "本轮明确保留项" },
        change: [userText], preserve: ["检验累积结构与颜色漂移；指定新修改覆盖旧修改", ...(reset ? ["原图重做不得恢复已撤销条件"] : [])] };
      jobs.push({ key, group: "sequence", sample, model, strategy: "minimal", round });
    }
  }
  if (jobs.filter(j => j.group === "single").length > config.allocation.single || jobs.filter(j => j.group === "sequence").length > config.allocation.sequence) throw new Error("PLAN_EXCEEDS_ALLOCATION");
  return jobs;
}

export function namespaceAttemptKey(key: string, batchId: string) {
  if (batchId !== INITIAL_BATCH_ID) validateBatchId(batchId);
  const result = batchId === INITIAL_BATCH_ID ? key : `batch:${batchId}:${key}`;
  if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(result)) throw new Error("INVALID_ATTEMPT_KEY");
  return result;
}

/** Each explicit batch owns its task identities and prior-round links; original snapshots remain unchanged. */
export function namespaceJobs(jobs: Job[], batchId = INITIAL_BATCH_ID): Job[] {
  return jobs.map(job => ({ ...job, key: namespaceAttemptKey(job.key, batchId), sample: { ...job.sample,
    sources: job.sample.sources.map(source => ({ ...source, ...(source.fromAttempt ? { fromAttempt: namespaceAttemptKey(source.fromAttempt, batchId) } : {}) })) } }));
}
