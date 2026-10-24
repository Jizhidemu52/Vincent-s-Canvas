/** Offline publication of this task's synthetic QA only. Never copies runtime DBs or credentials. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { qualityAssets } from "./prompt-quality-cases";
import { sanitizePublicText } from "./prompt-quality-matrix";

const root = resolve(import.meta.dir, "../.."), source = resolve(root, "output/prompt-optimization");
const destination = resolve(root, "docs/manual/prompt-optimization/testing");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const copied: Array<{ path: string; bytes: number; sha256: string }> = [];
const exists = (path: string) => stat(path).then(() => true, () => false);
const allowed = /\.(?:json|md|html|png|webp|jpg|jpeg|zip)$/i;
const secretField = /^(?:api[_-]?key|authorization|cookie|password|access[_-]?token|refresh[_-]?token|session[_-]?token|secret|credentials|encrypted[_-]?credentials)$/i;
const privateCanvasField = /^(?:systemPrompt|fieldTemplate|modelOverrides|fallbackPrompt|rawResponse|inputSnapshot)$/;
export function redactEvidenceJson(value: unknown, reject = false, canvas = false): unknown {
  if (Array.isArray(value)) return value.map(item => redactEvidenceJson(item, reject, canvas));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if ((secretField.test(key) || canvas && privateCanvasField.test(key)) && item !== null && item !== "" && item !== "[REDACTED]") {
      if (reject) throw new Error(`Forbidden nonempty field in evidence: ${key}`);
      return [key, "[REDACTED]"];
    }
    return [key, redactEvidenceJson(item, reject, canvas)];
  }));
}
function clean(value: string) {
  return sanitizePublicText(value).replaceAll(root.replaceAll("\\", "/") + "/", "").replaceAll(root + "\\", "")
    .replaceAll("output/prompt-optimization/quality-matrix/", "quality-matrix/");
}
async function publish(from: string, to: string) {
  if (!allowed.test(to) || /(?:\.sqlite|\.env|\.pem|\.key|\.dump)(?:$|[-.])/i.test(to)) throw new Error("Unsupported evidence file");
  const target = resolve(destination, to);
  if (!target.startsWith(destination + (process.platform === "win32" ? "\\" : "/"))) throw new Error("Invalid evidence path");
  await mkdir(resolve(target, ".."), { recursive: true });
  if (/\.(?:json|md|html)$/i.test(to)) {
    const raw = await readFile(from, "utf8");
    const contents = clean(/\.json$/i.test(to) ? JSON.stringify(redactEvidenceJson(JSON.parse(raw)), null, 2) : raw);
    if (/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(contents)) throw new Error("Credential-shaped material in evidence");
    await writeFile(target, contents.trimEnd() + "\n");
  } else {
    if (/\.zip$/i.test(to)) {
      const { unzipSync } = createRequire(resolve(root, "web/package.json"))("fflate") as { unzipSync: (bytes: Uint8Array, options: { filter: (file: { originalSize: number }) => boolean }) => Record<string, Uint8Array> };
      let expanded = 0;
      const files = unzipSync(await readFile(from), { filter: file => { expanded += file.originalSize; if (expanded > 100_000_000) throw new Error("Evidence ZIP exceeds bounded audit size"); return true; } });
      for (const [name, bytes] of Object.entries(files)) {
        if (/\.json$/i.test(name)) redactEvidenceJson(JSON.parse(Buffer.from(bytes).toString("utf8")), true, true);
        else if (!/\.(?:png|webp|jpg|jpeg)$/i.test(name) && !name.endsWith("/")) throw new Error("Unexpected evidence ZIP entry");
      }
    }
    await copyFile(from, target); // Preserve every image and archive byte.
  }
  const bytes = await readFile(target);
  copied.push({ path: to.replaceAll("\\", "/"), bytes: bytes.length, sha256: sha(bytes) });
}
async function folder(from: string, to: string, recursive = false) {
  if (!await exists(from)) return;
  if (await exists(resolve(from, ".run.lock"))) throw new Error(`QA run still active: ${basename(from)}`);
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isFile() && allowed.test(entry.name) && !entry.name.startsWith(".") && !/(?:^|[.-])private(?:[.-]|$)/i.test(entry.name)) await publish(resolve(from, entry.name), `${to}/${entry.name}`);
    else if (entry.isDirectory() && recursive) await folder(resolve(from, entry.name), `${to}/${entry.name}`, true);
  }
}
function accounting(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT c.id,c.request_id,c.recipe_key,c.recipe_version_id,c.status,c.reused_from_id,c.details,v.version,v.content_hash FROM prompt_compilations c JOIN prompt_recipe_versions v ON v.id=c.recipe_version_id ORDER BY c.created_at,c.id").all() as any[]).map(row => {
      const detail = JSON.parse(row.details);
      return { id: row.id, requestId: row.request_id, recipeKey: row.recipe_key, recipeVersionId: row.recipe_version_id, recipeVersion: row.version, recipeContentHash: row.content_hash, status: row.status, reusedFromId: row.reused_from_id,
        optimizerModelConfigId: detail.modelConfigId ?? null, latencyMs: detail.latencyMs ?? null, inputTokens: detail.inputTokens ?? null, outputTokens: detail.outputTokens ?? null,
        actualCost: detail.actualCost ?? null, estimatedCost: detail.estimatedCost ?? null, currency: detail.currency ?? null };
    });
  } finally { db.close(); }
}

async function main() {
await mkdir(destination, { recursive: true });
for (const run of ["visual-v1", "protocol-v2", "visual-v2-extended"]) await folder(resolve(source, "quality-matrix", run), `quality-matrix/${run}`);
for (const name of ["optimizer-live", "contract-v2", "supplement-v1", "chat-live-ui", "workflow-live-ui"]) await folder(resolve(source, name), name, true);
for (const entry of await readdir(source, { withFileTypes: true })) if (entry.isFile() && /(?:report|review).*(?:\.md|\.json)$/.test(entry.name)) await publish(resolve(source, entry.name), entry.name);
for (const name of ["test-results", "contract-check"]) await folder(resolve(source, "admin-e2e", name), `admin-e2e/${name}`, true);
const fixtures = [];
for (const [key, item] of Object.entries(qualityAssets)) {
  const file = `${key}${item.path.slice(item.path.lastIndexOf("."))}`;
  await publish(resolve(root, item.path), `fixtures/${file}`);
  fixtures.push({ key, originalPath: item.path, path: `fixtures/${file}`, description: item.description });
}
const stores = [
  ["demo-real-ui-and-matrix", resolve(source, "live-demo/state.sqlite")],
  ["two-model-initial-comparison", resolve(source, "optimizer-live/compilations.sqlite")],
  ["two-model-output-contract-regression", resolve(source, "contract-v2/compilations.sqlite")],
] as const;
const calls = stores.flatMap(([scope, path]) => accounting(path).map(row => ({ scope, ...row })));
const roots = calls.filter(row => !row.reusedFromId);
const metrics = { capturedAt: new Date().toISOString(), actualProviderInvoiceVerified: false, imageActualCost: null, chatActualCost: null,
  note: "Compilation POST attempts include cache aliases; root compilation rows bound optimizer invocations, not verified invoice charges. Unknown actual fees are null, never zero. Chat-profile calls and image submissions are separately recorded in each UI/matrix ledger.",
  compilationRecords: calls.length, rootCompilationRecords: roots.length, reusedCompilationRecords: calls.length - roots.length,
  knownInputTokens: roots.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0), knownOutputTokens: roots.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
  rootRecordsMissingUsage: roots.filter(row => row.inputTokens === null || row.outputTokens === null).length,
  rootRecordsWithReportedActualCost: roots.filter(row => row.actualCost !== null).length, calls, fixtures };
await writeFile(resolve(destination, "call-accounting.json"), JSON.stringify(metrics, null, 2));
const metricBytes = await readFile(resolve(destination, "call-accounting.json"));
copied.push({ path: "call-accounting.json", bytes: metricBytes.length, sha256: sha(metricBytes) });
await writeFile(resolve(destination, "evidence-manifest.json"), JSON.stringify({ exportedAt: new Date().toISOString(), originalImagesPreserved: true, runtimeDatabasesIncluded: false, files: copied.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2));
console.log(JSON.stringify({ files: copied.length, bytes: copied.reduce((sum, file) => sum + file.bytes, 0), compilationRecords: calls.length, rootCompilationRecords: roots.length, knownInputTokens: metrics.knownInputTokens, knownOutputTokens: metrics.knownOutputTokens, rootRecordsWithReportedActualCost: metrics.rootRecordsWithReportedActualCost }));
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.path) await main();
