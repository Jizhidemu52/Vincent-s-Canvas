/** Explicit paid supplement: fixed optimizer-output comparison and real alpha-mask QA.
 * Re-running only queries an attempted task. Source/provider/composite bytes stay separate.
 * Uses the isolated Demo QA database read-only for pixel evidence; never production data.
 */
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileTypeFromBuffer } from "file-type";

const root = resolve(import.meta.dir, "../..");
const out = resolve(root, "output/prompt-optimization/supplement-v1");
const base = "http://127.0.0.1:3100";
const dbPath = resolve(root, "output/prompt-optimization/live-demo/state.sqlite");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const modelId = "d5000000-0000-4000-8000-000000000001";
type Job = { id: string; prompt: string; sources: string[]; mask?: boolean; optimizer?: string; sample?: string };
const originalPath = resolve(root, "labs/design-workbench/assets/garment.png");
const comparison = JSON.parse(await readFile(resolve(root, "output/prompt-optimization/optimizer-live/results.json"), "utf8"));
const chosen = new Set(["generate-specified-text", "sketch-observed-details", "color-specific-region"]);
const jobs: Job[] = comparison.cases.filter((item: any) => chosen.has(item.sample) && item.compilation.status === "success")
  .map((item: any) => ({ id: `${item.model}-${item.sample}`, prompt: item.compilation.prompt, sources: item.sample.startsWith("generate-") ? [] : [originalPath], optimizer: item.model, sample: item.sample }));
for (const optimized of [false, true]) jobs.push({ id: `mask-${optimized ? "optimized" : "baseline"}`, mask: true,
  prompt: "只在透明蒙版限定的衣身中央区域添加一颗小小的红色五角星刺绣；不要改变衣服、纽扣、其余面料或背景。", sources: [originalPath, resolve(out, "alpha-mask.png")] });
if (!process.argv.includes("--execute")) { console.log(JSON.stringify({ mode: "dry-run", paidRequests: 0, jobs: jobs.map(({ id }) => id) })); process.exit(0); }
await mkdir(out, { recursive: true });
const pixels = Buffer.alloc(1024 * 1024 * 4, 255);
for (let y = 450; y < 640; y++) for (let x = 550; x < 735; x++) pixels[(y * 1024 + x) * 4 + 3] = 0;
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const mask = execFileSync(ffmpeg, ["-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "1024x1024", "-i", "pipe:0", "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"], { input: pixels, maxBuffer: 12 * 1024 * 1024, windowsHide: true });
await writeFile(resolve(out, "alpha-mask.png"), mask);
let ledger: any = { version: 1, upstreamCost: null, jobs: {}, assets: {} };
try { ledger = JSON.parse(await readFile(resolve(out, "ledger.json"), "utf8")); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
const persist = () => writeFile(resolve(out, "ledger.json"), JSON.stringify(ledger, null, 2));
const session: any = await (await fetch(`${base}/api/auth/session`)).json();
const owner = session.user.id;
const api = async (path: string, method = "GET", body?: unknown): Promise<any> => {
  const response = await fetch(base + path, { method, headers: { "x-canvas-owner-id": owner, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(240_000) });
  const value: any = await response.json(); if (!response.ok) throw new Error(String(value.error || `HTTP_${response.status}`)); return value;
};
const upload = async (file: string) => {
  const bytes = await readFile(file), hash = sha(bytes);
  if (!ledger.assets[hash]) {
    const type = await fileTypeFromBuffer(bytes); if (!type?.mime.startsWith("image/")) throw Error("INVALID_FIXTURE");
    const reservation = await api("/api/assets/upload-request", "POST", { filename: file.split(/[\\/]/).pop(), mimeType: type.mime, byteSize: bytes.length, kind: "image", metadata: { source: "prompt-quality-supplement", contentSha256: hash } });
    if (reservation.uploadUrl) {
      const target = new URL(reservation.uploadUrl, base); if (target.origin !== base) throw Error("EXTERNAL_UPLOAD_BLOCKED");
      const put = await fetch(target, { method: "PUT", body: bytes, headers: { "x-canvas-owner-id": owner, "content-type": type.mime } }); if (!put.ok) throw Error("UPLOAD_FAILED");
    }
    ledger.assets[hash] = reservation.assetId; await persist();
  }
  return `/api/assets/${ledger.assets[hash]}/content`;
};
const decode = (bytes: Uint8Array) => execFileSync(ffmpeg, ["-v", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { input: bytes, maxBuffer: 70 * 1024 * 1024, windowsHide: true });
for (const job of jobs) {
  const item = ledger.jobs[job.id] ||= { id: job.id, requestId: `pq:supplement-v1:${job.id}`, optimizer: job.optimizer, sample: job.sample };
  if (item.status === "success" || item.status === "failed") continue;
  try {
    const sourceUrls: string[] = [];
    for (const source of job.sources) sourceUrls.push(await upload(source));
    const parameters = { n: 1, size: "1024x1024", quality: "auto", ...(job.mask ? { output_format: "png", inputArchive: { maskReferenceIndex: 1 } } : {}) };
    if (!item.attempted) {
      item.attempted = true; await persist();
      const result = await api("/api/tasks", "POST", { requestId: item.requestId, projectId: "prompt-quality-supplement", operationType: sourceUrls.length ? "inpaint" : "image_generation", toolKey: sourceUrls.length ? "image-edit" : "image", modelConfigId: modelId, prompt: job.prompt, parameters, sourceUrls,
        ...(job.id === "mask-optimized" ? { promptInput: { scene: "free-optimize", fields: {}, userText: job.prompt, mode: "edit", outputLanguage: "zh", hasMask: true, maskReferenceIndex: 1, referenceRoles: ["需要保留的衬衫原图"] } } : {}) });
      item.taskId = result.task?.id; await persist();
    }
    const found = await api(`/api/tasks/by-request/${encodeURIComponent(item.requestId)}`);
    let task = found.task; if (!task) throw Error("TASK_UNKNOWN_NO_RESUBMIT");
    const deadline = Date.now() + 1_200_000;
    while (!["success", "failed", "paused", "cancelled"].includes(task.status)) {
      if (Date.now() > deadline) throw Error("POLL_TIMEOUT_NO_RESUBMIT");
      await Bun.sleep(3000); task = (await api(`/api/tasks/${task.id}`)).task;
    }
    item.taskId = task.id; item.status = task.status; item.errorCode = task.errorCode; item.finalPrompt = task.prompt; item.optimized = task.optimized;
    const db = new Database(dbPath, { readonly: true });
    try {
      const assets = db.query("SELECT fields_json, bytes FROM demo_assets WHERE json_extract(fields_json, '$.taskId')=?").all(task.id).map((row: any) => ({ fields: JSON.parse(row.fields_json), bytes: row.bytes as Uint8Array }));
      item.outputs = [];
      const sourcePixels = job.mask ? decode(await readFile(originalPath)) : undefined;
      for (const asset of assets) {
        const type = await fileTypeFromBuffer(asset.bytes); if (!type?.mime.startsWith("image/")) continue;
        const role = asset.fields.metadata?.imageResult?.role || "primary";
        const filename = `${job.id}-${role}.${type.ext}`; await writeFile(resolve(out, filename), asset.bytes);
        const result: any = { path: filename, role, mime: type.mime, bytes: asset.bytes.length, sha256: sha(asset.bytes), operations: asset.fields.metadata?.imageResult?.operations || [] };
        if (sourcePixels) {
          const actual = decode(asset.bytes);
          if (actual.length !== sourcePixels.length) result.pixelComparison = { status: "dimension-mismatch", sourceBytes: sourcePixels.length, resultBytes: actual.length };
          else {
            let outside = 0, outsideChanged = 0, inside = 0, insideChanged = 0;
            for (let p = 0; p < actual.length; p += 4) {
              const changed = actual[p] !== sourcePixels[p] || actual[p + 1] !== sourcePixels[p + 1] || actual[p + 2] !== sourcePixels[p + 2] || actual[p + 3] !== sourcePixels[p + 3];
              if (pixels[p + 3] === 255) { outside++; if (changed) outsideChanged++; } else { inside++; if (changed) insideChanged++; }
            }
            result.pixelComparison = { outside, outsideChanged, inside, insideChanged, strictOutsidePreserved: outsideChanged === 0 };
          }
        }
        item.outputs.push(result);
      }
    } finally { db.close(); }
    await persist(); console.log(JSON.stringify({ id: item.id, status: item.status, errorCode: item.errorCode, outputs: item.outputs?.length }));
  } catch (error) {
    item.status = "uncertain"; item.errorCode = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "UNCLASSIFIED_ERROR";
    await persist(); console.log(JSON.stringify({ id: item.id, status: item.status, errorCode: item.errorCode }));
  }
}
