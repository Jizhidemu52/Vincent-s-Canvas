/** Explicitly authorized paid QA only. Never run as part of tests or CI.
 * Run from server/: bun scripts/mark-provider-live-qa.ts baseline
 * Reads MARK_IMAGE_API_KEY on the server; records no credentials. Hard cap: 50 submissions.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runApiMartImageTask } from "../src/apimart-image";
import { fetchProviderResult } from "../src/provider-result";
import { createHash } from "node:crypto";

const output = resolve(import.meta.dir, "../../output/mark-provider-live");
const ledgerPath = resolve(output, "ledger.json");
const apiKey = process.env.MARK_IMAGE_API_KEY?.trim();
if (!apiKey) throw new Error("MARK_IMAGE_API_KEY is not configured; no API call was made");
const baseUrl = process.env.MARK_IMAGE_BASE_URL || "https://api.apimart.ai/v1";
const sourcePath = resolve(import.meta.dir, "../../labs/design-workbench/assets/garment.png");
const sourceBytes = await readFile(sourcePath);
const sourceDataUrl = `data:image/png;base64,${sourceBytes.toString("base64")}`;
const prompt = "仅将参考图中衬衫的浅蓝色面料改为墨绿色（屏幕参考色 #2E5B4E）。保留同一件短袖衬衫的版型、领型、袖长、缝线、褶皱、五颗浅蓝色纽扣、相机角度和白色背景。不要加文字、水印、装饰、口袋或更换商品。输出一张完整的正面商品图。";
const cases = [
  { id: "flare-baseline", modelId: "gpt-image-2.5-flare", parameters: { size: "1:1", resolution: "1k", quality: "high", output_format: "png" } },
  { id: "sunburst-baseline", modelId: "gpt-image-2.5-sunburst", parameters: { size: "1:1", resolution: "1k", quality: "high", output_format: "png" } },
  { id: "nano-baseline", modelId: "gemini-nano-banana-2.1", parameters: { size: "1:1", resolution: "1k" } },
];
if (process.argv[2] !== "baseline") throw new Error("Choose an explicit QA case group; no default paid execution");
await mkdir(output, { recursive: true });
let ledger: { limit: number; submitted: number; cases: Record<string, any>[] };
try { ledger = JSON.parse(await readFile(ledgerPath, "utf8")); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; ledger = { limit: 50, submitted: 0, cases: [] }; }
if (ledger.limit !== 50 || !Number.isInteger(ledger.submitted) || ledger.submitted < 0) throw new Error("Invalid QA ledger");
const persist = () => writeFile(ledgerPath, JSON.stringify(ledger, null, 2));

for (const testCase of cases) {
  let entry = ledger.cases.find(item => item.id === testCase.id);
  if (entry?.status === "success" || entry?.status === "failed" || (entry?.submissionStarted && !entry.taskId)) {
    console.log(JSON.stringify({ id: testCase.id, status: "skipped-existing", priorStatus: entry.status, submitted: ledger.submitted })); continue;
  }
  if (!entry) {
    entry = { ...testCase, prompt, sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"), status: "preparing", startedAt: new Date().toISOString() };
    ledger.cases.push(entry); await persist();
  }
  const current = entry;
  console.log(JSON.stringify({ id: testCase.id, status: "starting", modelId: testCase.modelId, submitted: ledger.submitted }));
  try {
    const urls = await runApiMartImageTask({ ...testCase, parameters: testCase.parameters as Record<string, unknown>, baseUrl, apiKey, prompt,
      sourceDataUrls: [sourceDataUrl], upstreamTaskId: current.taskId, submissionStarted: Boolean(current.submissionStarted),
      beforeSubmit: async () => {
        if (ledger.submitted >= 50) throw new Error("Authorized 50-call limit reached");
        ledger.submitted++;
        current.submissionStarted = new Date().toISOString(); current.status = "submitted"; await persist();
        console.log(JSON.stringify({ id: current.id, status: "submit", submitted: ledger.submitted, limit: 50 }));
      },
      onSubmitted: async taskId => { current.taskId = taskId; current.status = "polling"; await persist(); console.log(JSON.stringify({ id: current.id, status: "polling", taskId })); },
    });
    current.outputs = [];
    for (const [index, url] of urls.entries()) {
      const result = await fetchProviderResult(url);
      const extension = result.mimeType === "image/jpeg" ? "jpg" : result.mimeType === "image/webp" ? "webp" : "png";
      const filename = `${testCase.id}-${index + 1}.${extension}`;
      await writeFile(resolve(output, filename), result.bytes);
      current.outputs.push({ filename, mimeType: result.mimeType, bytes: result.bytes.byteLength, sha256: createHash("sha256").update(result.bytes).digest("hex") });
    }
    current.status = "success"; current.completedAt = new Date().toISOString(); await persist();
    console.log(JSON.stringify({ id: current.id, status: current.status, outputs: current.outputs, submitted: ledger.submitted }));
  } catch (error) {
    current.status = current.taskId || current.submissionStarted ? "needs-review" : "failed";
    current.error = (error instanceof Error ? error.message : "Unknown provider error").replaceAll(apiKey, "[redacted]");
    await persist();
    console.log(JSON.stringify({ id: current.id, status: current.status, error: current.error, submitted: ledger.submitted }));
    // A transport or contract failure stops this group; no automatic paid retry.
    break;
  }
}
