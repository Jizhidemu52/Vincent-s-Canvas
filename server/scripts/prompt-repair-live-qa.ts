/** Explicit local, paid repair QA. Isolated fixture DB only; attempted POSTs are never replayed. */
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { parsePromptRecipeDocument } from "../src/prompt-recipe-import";
import { sqlitePromptRecipeStore } from "../src/demo-prompt-recipes";
import { sanitizePublicText, selectCompilationCost } from "./prompt-quality-matrix";
import { qualityAssets, type QualityCase } from "./prompt-quality-cases";

const root = resolve(import.meta.dir, "../..");
const runId = process.env.PQ_REPAIR_RUN || "repair-v1";
if (!/^[a-z0-9-]{1,60}$/.test(runId)) throw Error("INVALID_RUN_ID");
const out = resolve(root, "output/prompt-optimization", runId);
const dbPath = resolve(root, "output/prompt-optimization/repair-v1/state.sqlite");
const base = "http://127.0.0.1:3100";
const modelConfigId = process.env.PQ_MODEL_CONFIG_ID || "d5000000-0000-4000-8000-000000000001";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Job = QualityCase & { fixedPrompt?: string };
const plans = await Promise.all(["visual-v1", "visual-v2-extended"].map(async name => JSON.parse(await readFile(resolve(root, `docs/manual/prompt-optimization/testing/quality-matrix/${name}/plan.json`), "utf8"))));
const wanted = ["pattern-extract-03-new", "pattern-extract-06-new", "pattern-craft-02-new", "pattern-craft-10-new", "style-to-sketch-11-new", "style-to-sketch-17-new", "pattern-extract-01-new", "pattern-extract-02-new", "pattern-colorway-01-new"];
const jobs: Job[] = wanted.map(id => { const item = plans.flatMap(plan => plan.cases).find(item => item.id === id); if (!item) throw Error(`CASE_NOT_FOUND:${id}`); return structuredClone(item); });
jobs.push({ id: "lettering-single-quote", group: "creative", label: "单引号指定印字", sources: ["flat"], toolKey: "creative-local-restyle", prompt: "在图片1衬衫左胸印上 'SUMMER 2026'，只加这一行文字，纽扣、胸袋和其他结构不变。",
  input: { scene: "local-restyle", fields: { restyleArea: "左胸", change: "只加指定印字", preserve: "纽扣数量、口袋、轮廓、衣身颜色不变" }, userText: "在图片1衬衫左胸印上 'SUMMER 2026'，只加这一行文字，纽扣、胸袋和其他结构不变。", mode: "edit", referenceRoles: ["原衬衫"] },
  checks: ["指定文字逐字为 SUMMER 2026", "不出现泛 no text 与正向印字冲突", "原纽扣、口袋和衣身结构保留"] });
for (const id of ["style-to-sketch-11-new", "style-to-sketch-17-new"]) jobs.push({ ...structuredClone(jobs.find(job => job.id === id)!), id: `${id}-repeat` });
const historic = JSON.parse(await readFile(resolve(root, "docs/manual/prompt-optimization/testing/quality-matrix/visual-v1/ledger.json"), "utf8"));
for (const native of [false, true]) jobs.push({ ...structuredClone(jobs.find(job => job.id === "pattern-colorway-01-new")!),
  id: `alpha-native-${native ? "on" : "off"}`, input: undefined, toolKey: "image-edit", fixedPrompt: historic.cases["pattern-colorway-01-new"].finalPrompt,
  parameters: { n: 1, size: "1024x1024", quality: "auto", ...(native ? { background: "transparent", output_format: "png" } : {}) } });
const selection = process.env.PQ_REPAIR_ONLY?.split(",");
const selected = jobs.filter(job => !selection || selection.some(id => job.id.startsWith(id)));
const recipes = parsePromptRecipeDocument(await readFile(resolve(root, "docs/manual/prompt-optimization/无线画布-板块系统提示词（机密）.md"), "utf8"));
await mkdir(out, { recursive: true });
await writeFile(resolve(out, "plan.json"), JSON.stringify({ runId, modelConfigId, jobs: selected, privateRulesIncluded: false,
  note: "Original fixture bytes; historical failures remain separate. No seed control; two repeats for sketch. Native alpha pair differs only by background/output_format." }, null, 2));
if (!process.argv.includes("--execute")) { console.log(JSON.stringify({ mode: "dry-run", paidRequests: 0, selected: selected.map(job => job.id) })); process.exit(0); }
const lockPath = resolve(out, ".run.lock");
const lock = await open(lockPath, "wx"); await lock.writeFile(JSON.stringify({ pid: process.pid, runId }));
let ledger: any = { version: 1, runId, modelConfigId, assets: {}, recipes: {}, jobs: {}, providerImageActualCost: null };
try { ledger = JSON.parse(await readFile(resolve(out, "ledger.json"), "utf8")); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
if (ledger.runId !== runId || ledger.modelConfigId !== modelConfigId) throw Error("LEDGER_IDENTITY_CHANGED");
let saves = Promise.resolve();
const persist = () => { const json = JSON.stringify(ledger, null, 2); saves = saves.then(async () => { await writeFile(resolve(out, "ledger.json.tmp"), json); await rename(resolve(out, "ledger.json.tmp"), resolve(out, "ledger.json")); }); return saves; };
let owner = "";
const recipeDb = sqlitePromptRecipeStore(dbPath);
const restoreVersions = new Map<string, string>();
const api = async (path: string, method = "GET", body?: unknown): Promise<any> => {
  const response = await fetch(base + path, { method, redirect: "error", headers: { ...(owner ? { "x-canvas-owner-id": owner } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(240_000) });
  const value: any = await response.json(); if (!response.ok) throw Error(String(value.error || `HTTP_${response.status}`)); return value;
};
const upload = async (key: keyof typeof qualityAssets) => {
  const bytes = await readFile(resolve(root, qualityAssets[key].path)), hash = sha(bytes);
  if (!ledger.assets[hash]) {
    const type = await fileTypeFromBuffer(bytes); if (!type?.mime.startsWith("image/")) throw Error("INVALID_FIXTURE");
    const reservation = await api("/api/assets/upload-request", "POST", { filename: `${key}.${type.ext}`, mimeType: type.mime, byteSize: bytes.length, kind: "image", metadata: { source: "prompt-repair-live-qa", contentSha256: hash } });
    if (reservation.uploadUrl) {
      const url = new URL(reservation.uploadUrl, base); if (url.origin !== base) throw Error("EXTERNAL_UPLOAD_BLOCKED");
      const response = await fetch(url, { method: "PUT", body: bytes, headers: { "x-canvas-owner-id": owner, "content-type": type.mime } }); if (!response.ok) throw Error("UPLOAD_FAILED");
    }
    ledger.assets[hash] = { id: reservation.assetId, key, sha256: hash }; await persist();
  }
  return `/api/assets/${ledger.assets[hash].id}/content`;
};
const evidence = async (task: any, record: any) => {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query("SELECT fields_json, bytes FROM demo_assets WHERE json_extract(fields_json, '$.taskId')=?").all(task.id) as any[];
    record.outputs = [];
    for (const row of rows) {
      const fields = JSON.parse(row.fields_json), bytes: Uint8Array = row.bytes;
      const type = await fileTypeFromBuffer(bytes); if (!type?.mime.startsWith("image/")) continue;
      const role = fields.metadata?.imageResult?.role || "primary";
      const path = `${record.id}-${role}.${type.ext}`;
      await writeFile(resolve(out, path), bytes);
      const pixels = execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { input: bytes, maxBuffer: 70 * 1024 * 1024, windowsHide: true });
      let transparent = 0, partial = 0;
      for (let i = 3; i < pixels.length; i += 4) { if (pixels[i]! < 255) transparent++; if (pixels[i]! > 0 && pixels[i]! < 255) partial++; }
      record.outputs.push({ path, role, mime: type.mime, bytes: bytes.length, sha256: sha(bytes), pixels: pixels.length / 4, transparentPixels: transparent, fullyTransparentPixels: transparent - partial, opaquePixels: pixels.length / 4 - transparent, partialAlphaPixels: partial, operations: fields.metadata?.imageResult?.operations || [] });
    }
  } finally { db.close(); }
};
try {
  owner = (await api("/api/auth/session")).user.id;
  if (ledger.ownerHash && ledger.ownerHash !== sha(owner)) throw Error("LEDGER_OWNER_CHANGED"); ledger.ownerHash = sha(owner);
  const models = (await api("/api/models")).models;
  const model = models.find((item: any) => item.id === modelConfigId); if (!model) throw Error("MODEL_MISSING");
  ledger.model = { id: model.id, publicModelId: model.modelId, name: model.name, identityNote: "Public model identity can be redacted for the designer session; config ID pins the actual local runtime selection." };
  // Demo deliberately has no admin HTTP access. Prepare only this disposable local fixture DB;
  // all paid compilation/generation still uses the public application paths. Restore after QA.
  for (const key of new Set(selected.map(job => job.input?.scene).filter(Boolean))) {
    const content = recipes.find(recipe => recipe.key === key)!.content;
    if (ledger.recipes[key!] && ledger.recipes[key!].hash !== sha(JSON.stringify(content))) throw Error("RECIPE_CHANGED_NEW_RUN_REQUIRED");
    const current = await recipeDb.store.get(key!);
    if (!ledger.recipes[key!]) { const version = await recipeDb.store.saveVersion(key!, content, "local-repair-qa"); ledger.recipes[key!] = { id: version.id, contentHash: version.contentHash, hash: sha(JSON.stringify(content)), previousVersionId: current.currentVersionId }; await persist(); }
    restoreVersions.set(key!, ledger.recipes[key!].previousVersionId);
    await recipeDb.store.activate(key!, ledger.recipes[key!].id);
  }
  // Upload serially so shared fixtures have one stable identity before parallel paid work.
  const sources: Record<string, string> = {};
  for (const key of new Set(selected.flatMap(job => job.sources))) sources[key] = await upload(key);
  const run = async (job: Job) => {
    const id = job.id, record = ledger.jobs[id] ||= { id, requestId: `pq:${runId}:${id}`, compilationRequestId: `pq:${runId}:${id}:compile`, inputHash: sha(JSON.stringify(job)), visualReview: "pending" };
    if (record.inputHash !== sha(JSON.stringify(job))) throw Error("INPUT_CHANGED_NEW_RUN_REQUIRED");
    if (["success", "failed"].includes(record.status) || record.status === "paused" && !process.argv.includes("--recover-download")) return;
    try {
      const sourceUrls = job.sources.map(key => sources[key]);
      if (job.input && !record.compilation) {
        let value;
        if (!record.compileAttempted) {
          record.compileAttempted = true; await persist();
          value = await api("/api/prompt-compilations", "POST", { requestId: record.compilationRequestId, modelConfigId, toolKey: job.toolKey, promptInput: job.input, sourceUrls });
        } else value = await api(`/api/prompt-compilations/by-request/${record.compilationRequestId}`);
        record.compilation = value.compilation; await persist();
      }
      if (job.input && record.compilation.status !== "success") throw Error(record.compilation.errorCode || "COMPILATION_NOT_SUCCESS");
      if (record.compilation) {
        const compilation = await recipeDb.store.getCompilation(record.compilation.id);
        if (!compilation) throw Error("COMPILATION_EVIDENCE_MISSING");
        record.compilationCost = selectCompilationCost(compilation); record.recipeVersionId = compilation.recipeVersionId;
      }
      if (!record.taskAttempted) {
        record.taskAttempted = true; await persist();
        const result = await api("/api/tasks", "POST", { requestId: record.requestId, projectId: "prompt-repair-qa", operationType: "inpaint", toolKey: job.toolKey, modelConfigId,
          prompt: job.fixedPrompt || record.compilation?.prompt || job.prompt, parameters: job.parameters || { n: 1, size: "1024x1024", quality: "auto" }, sourceUrls,
          ...(job.input ? { promptInput: { ...job.input, compilationId: record.compilation.id } } : {}) });
        record.taskId = result.task?.id; await persist();
      }
      let { task } = await api(`/api/tasks/by-request/${record.requestId}`);
      if (!task) throw Error("TASK_UNKNOWN_NO_RESUBMIT");
      if (task.status === "paused" && task.errorCode === "MARK_IMAGE_STATUS_UNCERTAIN" && String(task.failureReason).includes("下载暂时失败") && process.argv.includes("--recover-download") && !record.recoveryAttempted) {
        record.recoveryAttempted = true; await persist();
        // Existing upstream result only. The application never issues another generation POST here.
        await api(`/api/tasks/${task.id}/recover`, "POST", {});
        task = (await api(`/api/tasks/${task.id}`)).task;
      }
      const deadline = Date.now() + 1_200_000;
      while (!["success", "failed", "paused", "cancelled"].includes(task.status)) {
        if (Date.now() > deadline) throw Error("POLL_TIMEOUT_NO_RESUBMIT");
        await Bun.sleep(3000); task = (await api(`/api/tasks/${task.id}`)).task;
      }
      Object.assign(record, { taskId: task.id, status: task.status, errorCode: task.errorCode, failureReason: sanitizePublicText(task.failureReason || ""), finalPrompt: task.prompt, parameters: task.parameters, applicationConfiguredChargeRmb: task.rmbCost });
      await evidence(task, record); await persist(); console.log(JSON.stringify({ id, status: record.status, alpha: record.outputs.map((o: any) => o.transparentPixels) }));
    } catch (error: any) { record.status = record.compilation?.status === "failed" && !record.taskAttempted ? "failed" : "uncertain"; record.errorCode = /^[A-Z0-9_:]+$/.test(error.message) ? error.message : "QA_FAILED_NO_RESUBMIT"; await persist(); console.log(JSON.stringify({ id, status: record.status, errorCode: record.errorCode })); }
  };
  const pending = [...selected];
  await Promise.all(Array.from({ length: 3 }, async () => { for (;;) { const job = pending.shift(); if (!job) break; await run(job); } }));
  console.log(JSON.stringify({ runId, statuses: Object.values(ledger.jobs).map((item: any) => ({ id: item.id, status: item.status })) }));
} finally {
  for (const [key, versionId] of restoreVersions) if (versionId) await recipeDb.store.activate(key, versionId);
  recipeDb.close(); await saves; await lock.close(); await unlink(lockPath);
}
