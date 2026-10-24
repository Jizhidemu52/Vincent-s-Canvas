/** Explicit, bounded paid regression for the five v1 omitted-field failures. No image generation. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sqlitePromptRecipeStore } from "../src/demo-prompt-recipes";
import { importPromptRecipes } from "../src/prompt-recipe-import";
import { PromptCompiler, type PromptCompilerRuntime } from "../src/prompt-compiler";
import { promptSourceFromBytes } from "../src/prompt-runtime";
import { requestChatCompletion } from "../src/routes/chat";
import { qualityAssets, type QualityCase } from "./prompt-quality-cases";
import { promptCompilationRequestSchema } from "../../shared/prompt-contracts";

const selected = ["style-to-sketch-01-new", "style-to-sketch-02-new", "accessory-design-02-new", "template-development-1-1", "template-range-2-1"];
if (!process.argv.includes("--execute")) { console.log(JSON.stringify({ cases: selected, models: 2, maximumNewCalls: 10, images: 0, execute: false })); process.exit(0); }
const apiKey = process.env.MARK_IMAGE_API_KEY?.trim() || process.env.APIMART_API_KEY?.trim();
if (!apiKey) throw new Error("Missing configured API key; no request was made");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "output/prompt-optimization/contract-v2");
await mkdir(output, { recursive: true });
const plan = JSON.parse(await readFile(resolve(root, "output/prompt-optimization/quality-matrix/visual-v1/plan.json"), "utf8"));
const samples = (plan.cases as QualityCase[]).filter(item => selected.includes(item.id));
if (samples.length !== selected.length || samples.some(item => !item.input)) throw new Error("Expected all five original failing inputs");
const database = sqlitePromptRecipeStore(resolve(output, "compilations.sqlite"));
const actor = { id: "prompt-contract-qa", role: "super_admin", departmentId: null };
const models = [{ id: "b07b7625-63e4-4ea5-9706-ec9295b9392f", modelId: "claude-sonnet-5-5" }, { id: "652b3d3c-9bdf-419e-851f-31c5e101daf6", modelId: "gpt-6-astra" }];
const source = await readFile(resolve(root, "docs/manual/prompt-optimization/无线画布-板块系统提示词（机密）.md"), "utf8");
await importPromptRecipes(database.store, source, { actorId: actor.id, modelConfigId: models[1]!.id, activate: true });
const runtime: PromptCompilerRuntime = {
  resolveTarget: async () => ({ id: "9b560bcc-539d-42a3-a977-696f11146ca9", modelId: "gpt-image-2.5-flare", protocol: "apimart", fingerprint: "apimart-gpt-image-2.5-flare" }),
  resolveOptimizer: async id => {
    const model = models.find(item => item.id === id); if (!model) throw new Error("Unknown QA model");
    return { id, modelId: model.modelId, fingerprint: model.modelId, estimatedRmbCost: null,
      invoke: (system, content) => requestChatCompletion({ model_id: model.modelId, base_url: process.env.MARK_IMAGE_BASE_URL || process.env.APIMART_BASE_URL || "https://api.apimart.ai/v1", protocol: "apimart", encrypted_credentials: null }, { apiKey },
        { privateProfile: true, input: [{ role: "system", content: system }, { role: "user", content }], tools: [], claude: { thinking: false, stream: false, maxTokens: 4096 }, gemini: { maxOutputTokens: 4096 } }),
    };
  },
  readSource: async (_actor, url) => {
    const asset = qualityAssets[url as keyof typeof qualityAssets]; if (!asset) throw new Error("Unknown QA asset");
    return promptSourceFromBytes(await readFile(resolve(root, asset.path)), asset.path.endsWith(".webp") ? "image/webp" : "image/png");
  },
};
const compiler = new PromptCompiler(database.store, runtime);
const results: Array<Record<string, unknown>> = [];
const persist = () => writeFile(resolve(output, "results.json"), JSON.stringify({ models, cases: results, originalFailuresRetained: true, imagesSubmitted: 0, actualCostUnavailableIsNotZero: true }, null, 2));
try {
  for (const model of models) for (const sample of samples) {
    const request = promptCompilationRequestSchema.parse({ requestId: `contract-v2:${model.modelId}:${sample.id}`, modelConfigId: "9b560bcc-539d-42a3-a977-696f11146ca9", promptInput: sample.input, sourceUrls: sample.sources });
    const compilation = await compiler.compile(actor, request, { optimizerModelConfigId: model.id });
    results.push({ model: model.modelId, case: sample.id, passed: compilation.status === "success", compilation });
    await persist();
    console.log(JSON.stringify({ model: model.modelId, case: sample.id, status: compilation.status, errorCode: compilation.errorCode, latencyMs: compilation.latencyMs }));
  }
} finally { await persist(); database.close(); }
