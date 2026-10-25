/** Offline, allow-listed publication of synthetic repair QA. No network or runtime DB export. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { sanitizePublicText } from "./prompt-quality-matrix";

const root = resolve(import.meta.dir, "../.."), source = resolve(root, "output/prompt-optimization");
const destination = resolve(root, "docs/manual/prompt-optimization/testing/repair-v0.5.6");
const runs = ["repair-v1", "repair-v2", "repair-sunburst-alpha", "repair-opentoken-alpha", "repair-lettering"];
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const reviews: Record<string, [string, string]> = {
  "repair-v1/pattern-extract-03-new": ["NOT_GENERATED", "优化失败，未提交生图。后续修改规则后使用新的请求编号验证，未重放此请求。"],
  "repair-v1/pattern-extract-06-new": ["PASS", "横向纹样带完整保留可见边界，没有补出画外元素。"],
  "repair-v1/pattern-craft-02-new": ["PASS", "四片叶子和枝干完整入镜；工艺纹理可见，四周有留白。"],
  "repair-v1/pattern-craft-10-new": ["PASS", "花形完整入镜，外轮廓未被微距构图裁掉；工艺细节清晰。"],
  "repair-v1/style-to-sketch-11-new": ["PASS", "五颗完整纽扣及领口半遮挡纽扣保留；无新增口袋。"],
  "repair-v1/style-to-sketch-17-new": ["PASS", "纽扣数量、领口遮挡和主要结构符合要求。"],
  "repair-v1/style-to-sketch-11-new-repeat": ["MINOR_FIX", "五颗完整纽扣保留，但领尖变圆，领口遮挡形状轻微漂移。"],
  "repair-v1/style-to-sketch-17-new-repeat": ["PASS", "重复出图仍保留五颗完整纽扣及半遮挡领口纽扣。"],
  "repair-v1/pattern-extract-01-new": ["REDO", "已出现真实 alpha，但边缘有光晕、花瓣线条丢失，不是保真提取。"],
  "repair-v1/pattern-colorway-01-new": ["REDO", "已出现真实 alpha，但轮廓光晕及内部细节漂移仍存在。"],
  "repair-v1/alpha-native-off": ["CONTROL", "固定提示词、不发原生透明参数：结果全不透明。"],
  "repair-v1/alpha-native-on": ["REDO", "同一提示词增加原生透明参数后出现 alpha，但仍有大范围柔边和光晕。"],
  "repair-v2/pattern-extract-03-new": ["REDO", "提示词已禁止补全，出图仍把原来的不规则几何单元重构成近似雪花，不合格。"],
  "repair-v2/pattern-extract-01-new": ["REDO", "追加平面、实心和禁止光晕要求后，透明边缘及花瓣细节仍不合格。"],
  "repair-v2/pattern-extract-02-new": ["PASS", "白底四叶枝干完整，叶脉、相对位置与元素数量保留。"],
  "repair-v2/pattern-colorway-01-new": ["REDO", "追加禁止整体降透明度和光晕要求后仍有光晕，不能当作像素保真换色。"],
  "repair-sunburst-alpha/alpha-native-off": ["CONTROL", "Sunburst 固定提示词、不发原生透明参数：全不透明。"],
  "repair-sunburst-alpha/alpha-native-on": ["REDO", "Sunburst 原生透明参数有效，但柔边光晕仍不合格。"],
  "repair-opentoken-alpha/alpha-native-off": ["NOT_GENERATED", "上游返回 insufficient enterprise balance；没有成图，无法判断视觉质量。"],
  "repair-opentoken-alpha/alpha-native-on": ["NOT_GENERATED", "上游返回 insufficient enterprise balance；没有成图，无法判断透明能力。"],
  "repair-lettering/lettering-single-quote": ["MINOR_FIX", "SUMMER 2026 逐字正确，五颗纽扣和胸袋保留；原平面底色新增渐变。"],
};
const fixture = (id: string) => id.startsWith("style-to-sketch") ? "shirt" : id.startsWith("lettering") ? "flat"
  : /pattern-extract-(03|06)/.test(id) ? "knit" : /(?:pattern-extract|pattern-craft)-02/.test(id) ? "leaf" : "flower";
const safeParameters = (value: Record<string, unknown> = {}) => Object.fromEntries(Object.entries(value).filter(([key]) => ["n", "size", "quality", "background", "output_format", "tool", "count"].includes(key)));
const html = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const files: Array<{ path: string; bytes: number; sha256: string }> = [];
async function recordFile(path: string) {
  const bytes = await readFile(resolve(destination, path));
  files.push({ path, bytes: bytes.length, sha256: sha(bytes) });
}
async function publishText(path: string, value: string) {
  const text = sanitizePublicText(value);
  if (/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) throw Error("CREDENTIAL_SHAPED_EVIDENCE");
  await writeFile(resolve(destination, path), text.trimEnd() + "\n"); await recordFile(path);
}

await mkdir(destination, { recursive: true });
const db = new Database(resolve(source, "repair-v1/state.sqlite"), { readonly: true });
try {
  const historical = await Promise.all(["visual-v1", "visual-v2-extended"].map(async run => ({ run, files: await readdir(resolve(destination, `../quality-matrix/${run}`)) })));
  const records: any[] = [], restorations: any[] = [];
  for (const run of runs) {
    const ledger = JSON.parse(await readFile(resolve(source, run, "ledger.json"), "utf8"));
    await mkdir(resolve(destination, run), { recursive: true });
    for (const [key, value] of Object.entries(ledger.recipes) as Array<[string, any]>) {
      const current = db.query("SELECT current_version_id FROM prompt_recipes WHERE key=?").get(key) as any;
      if (current?.current_version_id !== value.previousVersionId) throw Error(`QA_RECIPE_NOT_RESTORED:${key}`);
      restorations.push({ run, key, candidateVersionId: value.id, candidateContentHash: value.contentHash, previousVersionId: value.previousVersionId, restored: true });
    }
    for (const job of Object.values(ledger.jobs) as any[]) {
      const review = reviews[`${run}/${job.id}`]; if (!review) throw Error(`MISSING_REVIEW:${run}/${job.id}`);
      const row = db.query("SELECT c.id,c.status,c.recipe_version_id,c.reused_from_id,c.details,v.content_hash FROM prompt_compilations c JOIN prompt_recipe_versions v ON c.recipe_version_id=v.id WHERE c.request_id=?").get(job.compilationRequestId) as any;
      const details = row ? JSON.parse(row.details) : null;
      const taskRow = db.query("SELECT fields_json FROM demo_tasks WHERE json_extract(fields_json,'$.requestId')=?").get(job.requestId) as any;
      const task = taskRow ? JSON.parse(taskRow.fields_json) : null;
      const outputs = [];
      for (const output of job.outputs || []) {
        if (basename(output.path) !== output.path || !/\.png$/.test(output.path)) throw Error("INVALID_OUTPUT_PATH");
        const bytes = await readFile(resolve(source, run, output.path));
        if (sha(bytes) !== output.sha256) throw Error("SOURCE_HASH_MISMATCH");
        const path = `${run}/${output.path}`; await copyFile(resolve(source, run, output.path), resolve(destination, path)); await recordFile(path);
        outputs.push({ ...output, path });
      }
      const baselineId = job.id.startsWith("alpha-native") ? "pattern-colorway-01-new" : job.id.replace(/-repeat$/, "");
      const baseline = historical.flatMap(folder => folder.files.filter(file => file.startsWith(baselineId + "-") && file.endsWith(".png")).map(file => `../quality-matrix/${folder.run}/${file}`))[0] ?? null;
      records.push({ run, id: job.id, requestId: job.requestId, taskId: job.taskId ?? null, model: ledger.model,
        recordedStatus: job.status, verifiedStatus: task?.status ?? (row?.status === "failed" ? "compilation_failed" : "unknown"),
        errorCode: task?.errorCode ?? details?.errorCode ?? job.errorCode ?? null, failureReason: job.failureReason ?? null,
        compileAttempted: !!job.compileAttempted, imageSubmissionAttempted: !!job.taskAttempted, originalTaskDownloadRecovery: !!job.recoveryAttempted,
        promptInput: details?.inputSnapshot?.promptInput ?? null, finalPrompt: job.finalPrompt ?? details?.prompt ?? null,
        parameters: safeParameters(job.parameters), referenceFixture: `../fixtures/${fixture(job.id)}.png`, historicalBaseline: baseline,
        compilation: row ? { id: row.id, status: row.status, recipeVersionId: row.recipe_version_id, recipeContentHash: row.content_hash, reusedFromId: row.reused_from_id,
          optimizerModelConfigId: details.modelConfigId ?? null, inputTokens: details.inputTokens ?? null, outputTokens: details.outputTokens ?? null,
          actualCost: details.actualCost ?? null, estimatedCost: details.estimatedCost ?? null, currency: details.currency ?? null } : null,
        outputs, visualReview: { grade: review[0], reason: review[1] } });
    }
  }
  const roots = records.filter(row => row.compilation && !row.compilation.reusedFromId);
  const metrics = { records: records.length, compilationPostAttempts: records.filter(row => row.compileAttempted).length,
    rootCompilationRecords: roots.length, cacheAliases: records.filter(row => row.compilation?.reusedFromId).length,
    compilationFailures: records.filter(row => row.verifiedStatus === "compilation_failed").length,
    imageSubmissionAttempts: records.filter(row => row.imageSubmissionAttempted).length, images: records.reduce((sum, row) => sum + row.outputs.length, 0),
    downloadRecoveriesWithoutRegeneration: records.filter(row => row.originalTaskDownloadRecovery).length,
    knownInputTokens: roots.reduce((sum, row) => sum + (row.compilation.inputTokens ?? 0), 0), knownOutputTokens: roots.reduce((sum, row) => sum + (row.compilation.outputTokens ?? 0), 0),
    rootRecordsMissingUsage: roots.filter(row => row.compilation.inputTokens === null || row.compilation.outputTokens === null).length,
    actualProviderInvoiceVerified: false, actualProviderTotalCost: null,
    visualGrades: Object.fromEntries(["PASS", "MINOR_FIX", "REDO", "CONTROL", "NOT_GENERATED"].map(grade => [grade, records.filter(row => row.visualReview.grade === grade).length])) };
  await publishText("report.json", JSON.stringify({ release: "v0.5.6", metrics, recipeRestoration: restorations,
    scope: "Synthetic fixtures, isolated local cloned DB; no production deploy or recipe activation. Provider invoice unavailable. Submissions and root compilations are not invoice-confirmed billable counts.",
    alphaMetricNote: "transparentPixels counts any alpha below 255, not just background. An alpha channel or any translucent pixel does not prove clean cutout edges or an opaque subject. No automatic cutout or source-alpha overlay was used.",
    records }, null, 2));
  const cards = records.map(row => `<article><h2>${html(row.run)} / ${html(row.id)} — ${html(row.visualReview.grade)}</h2><p>${html(row.visualReview.reason)}</p><p>接口：${html(row.verifiedStatus)} · ${html(row.model.name)}</p><div class="images"><figure><img src="${html(row.referenceFixture)}"><figcaption>原参考图</figcaption></figure>${row.historicalBaseline ? `<figure><img src="${html(row.historicalBaseline)}"><figcaption>历史失败／对照（非本轮重跑）</figcaption></figure>` : ""}${row.outputs.map((out: any) => `<figure><img src="${html(out.path)}"><figcaption>本轮原始结果 · alpha&lt;255: ${out.transparentPixels}/${out.pixels}</figcaption></figure>`).join("")}</div><details><summary>实际提示词和参数</summary><pre>${html(row.finalPrompt)}\n${html(JSON.stringify(row.parameters, null, 2))}</pre></details></article>`).join("\n");
  await publishText("gallery.html", `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>v0.5.6 修复验证</title><style>body{max-width:1400px;margin:30px auto;padding:0 20px;font:16px/1.6 system-ui;color:#232323;background:#f4f4f2}article{margin:30px 0;padding:20px;background:white;border:1px solid #ccc}.images{display:flex;flex-wrap:wrap;gap:14px}figure{flex:1;min-width:220px;margin:0}img{width:100%;height:360px;object-fit:contain;background:repeating-conic-gradient(#ddd 0% 25%,#fff 0% 50%) 50%/24px 24px}pre{white-space:pre-wrap;overflow-wrap:anywhere}h2{font-size:18px}</style><h1>v0.5.6 修复与真实出图验证</h1><p>原始 PNG 未改写。棋盘格仅为网页背景，不在图片里。PASS 是本组需求人工目视通过，不是像素一致、生产可用或稳定成功率。历史图没有同种子控制。</p><p><a href="report.json">完整脱敏记录、用量和参数</a> · <a href="README.md">结论与边界</a></p>${cards}</html>`);
  await publishText("evidence-manifest.json", JSON.stringify({ originalImageBytesPreserved: true, runtimeDatabasesIncluded: false, files: [...files].sort((a, b) => a.path.localeCompare(b.path)) }, null, 2));
  console.log(JSON.stringify({ ...metrics, exportedFiles: files.length, exportedBytes: files.reduce((sum, file) => sum + file.bytes, 0) }));
} finally { db.close(); }
