import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PromptCompilationRequest } from "../../shared/prompt-contracts";
import { sqlitePromptRecipeStore } from "../src/demo-prompt-recipes";
import { installNewCreativeRecipes } from "../src/new-creative-recipes";
import { PromptCompiler, type PromptCompilerRuntime } from "../src/prompt-compiler";
import { publicPromptCompilation } from "../src/prompt-recipe-store";
import { parseOptimizedPrompt } from "../src/prompt-safety";
import { preparePromptTaskInput } from "../src/prompt-task-input";

const closes: Array<() => void> = [];
afterEach(() => closes.splice(0).forEach(close => close()));
const actor = { id: "contract-employee", role: "designer" };
const output = { prompt: "Dress the adult model in Image 2 in the unchanged garment from Image 1.", avoid: ["watermark"], keep_text: [] };
const options = { referenceCount: 2, userText: "", language: "en" as const };

async function fixture(rawResponse = JSON.stringify(output)) {
  const database = sqlitePromptRecipeStore(":memory:"); closes.push(database.close);
  await installNewCreativeRecipes(database.store, { actorId: "admin", optimizerModelConfigId: "optimizer", activate: true });
  const systems: string[] = [];
  const runtime: PromptCompilerRuntime = {
    resolveTarget: async () => ({ id: "target", modelId: "gpt-image-2.6-flare", protocol: "apimart", fingerprint: "target" }),
    resolveOptimizer: async () => ({ id: "optimizer", modelId: "optimizer", fingerprint: "optimizer", estimatedRmbCost: 0.02,
      invoke: async system => { systems.push(system); return { content: rawResponse, usage: { inputTokens: 100, outputTokens: 50 } }; },
    }),
    readSource: async (_actor, url) => ({ bytes: Buffer.from(url), mimeType: "image/png", previewDataUrl: "data:image/png;base64,eA==" }),
  };
  return { ...database, compiler: new PromptCompiler(database.store, runtime), systems };
}
function input(scene: "virtual-try-on" | "sketch-to-photo"): PromptCompilationRequest {
  return { requestId: randomUUID(), modelConfigId: "target", toolKey: `creative-${scene}`, sourceUrls: ["product", "reference"],
    promptInput: { scene, fields: scene === "virtual-try-on" ? { description: "成年模特", keepDetails: "保留产品结构" }
      : { fabric: "棉布", colorDescription: "蓝色", presentation: "白底平铺" }, userText: "", referenceRoles: [], mode: "edit", hasMask: false } };
}

describe("image optimizer output contract", () => {
  test.each(["virtual-try-on", "sketch-to-photo"] as const)("%s sends the enforced bounds even when its stored recipe omitted them", async scene => {
    const f = await fixture();
    const before = await f.store.active(scene);
    expect(before.version.systemPrompt).not.toContain("avoid 最多 8 项");
    const result = await f.compiler.compile(actor, input(scene));
    expect(result.status).toBe("success");
    expect(f.systems).toHaveLength(1);
    expect(f.systems[0]).toContain("avoid 最多 8 项，每项最多 500 个字符");
    expect(f.systems[0]).toContain("keep_text 最多 50 项，每项必须为 1 至 1000 个字符");
    expect(f.systems[0]).toContain("合并同类项但不能丢弃任何必要的限制");
    expect(await f.store.active(scene)).toEqual(before);
  });

  test.each([9, 14])("%i avoid clauses remain a terminal 422 with the raw response retained and no automatic retry", async count => {
    const rawResponse = JSON.stringify({ ...output, avoid: Array.from({ length: count }, (_, index) => `unwanted detail ${index}`) });
    const f = await fixture(rawResponse), request = input("virtual-try-on");
    const submission = { ...request, operationType: "inpaint", prompt: "", parameters: {} };
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(preparePromptTaskInput(f.compiler, actor, submission)).rejects.toMatchObject({ code: "PROMPT_OUTPUT_INVALID", status: 422 });
    }
    const result = (await f.store.byRequest(actor.id, request.requestId))!;
    expect(result).toMatchObject({ status: "failed", rawResponse, inputTokens: 100, outputTokens: 50, estimatedCost: 0.02 });
    expect(result.prompt).toBeUndefined();
    expect(publicPromptCompilation(result)).not.toHaveProperty("rawResponse");
    expect(f.systems).toHaveLength(1);
  });

  test("accepts exact array and item limits, rejecting their first overflow without truncating", () => {
    const bounded = { ...output, avoid: Array(8).fill("x".repeat(500)) };
    const accepted = parseOptimizedPrompt(JSON.stringify(bounded), [], options);
    expect(accepted.prompt).toBe(`${output.prompt}\nAvoid: ${bounded.avoid.join(", ")}.`);
    const literal = "w".repeat(1000);
    expect(parseOptimizedPrompt(JSON.stringify({ prompt: literal, avoid: [], keep_text: [literal] }), [], options).keepText).toEqual([literal]);
    expect(parseOptimizedPrompt(JSON.stringify({ prompt: "w", avoid: [], keep_text: Array(50).fill("w") }), [], options).keepText).toEqual(["w"]);
    for (const patch of [{ avoid: "watermark" }, { avoid: [1] }, { avoid: ["x".repeat(501)] }, { keep_text: "text" }, { keep_text: [null] }, { keep_text: [""] }, { keep_text: ["w".repeat(1001)] }, { keep_text: Array(51).fill("w") }]) {
      expect(() => parseOptimizedPrompt(JSON.stringify({ ...output, ...patch }), [], options)).toThrow("提示词约束格式无效");
    }
  });
});
