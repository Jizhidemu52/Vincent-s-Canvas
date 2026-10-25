import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { promptImageBackground } from "../src/prompt-image-background";
import { preparePromptTaskInput } from "../src/prompt-task-input";
import type { PromptCompiler, PromptSource } from "../src/prompt-compiler";
import type { PromptInput } from "../../shared/prompt-contracts";

const target = { id: "flare", modelId: "gpt-image-2.5-flare", protocol: "apimart", fingerprint: "flare" };
const scene = (patch: Partial<PromptInput> = {}): PromptInput => ({ scene: "pattern-extract", fields: { extractBackground: "保留底色" }, userText: "保留原图背景", mode: "edit", referenceRoles: [], hasMask: false, ...patch });
async function source(name: "flower" | "knit"): Promise<PromptSource> {
  const bytes = await readFile(new URL(`../../docs/manual/prompt-optimization/testing/fixtures/${name}.png`, import.meta.url));
  return { bytes, mimeType: "image/png", previewDataUrl: "data:image/png;base64," + bytes.toString("base64") };
}
describe("structured artwork background contract", () => {
  test("white field overrides stale browser transparency without inspecting alpha", async () => {
    const parameters = { background: "transparent", output_format: "png" };
    const result = await promptImageBackground(scene({ fields: { extractBackground: "白底" } }), target, async () => { throw Error("must not read"); }, parameters);
    expect(result.background).toBe("opaque"); expect(parameters.background).toBe("transparent");
  });
  test("white on Nano removes unsupported background parameter", async () => {
    expect(await promptImageBackground(scene({ fields: { extractBackground: "白底" } }), { ...target, modelId: "gemini-nano-banana-2.1" }, async () => { throw Error("must not read"); }, { background: "transparent" })).toEqual({});
  });
  test("preserve background inspects real alpha, not presence of PNG extension", async () => {
    expect(await promptImageBackground(scene(), target, () => source("flower"), {})).toEqual({ background: "transparent", output_format: "png" });
    expect(await promptImageBackground(scene(), target, () => source("knit"), {})).toEqual({ background: "opaque" });
  });
  test("opaque source background wins over stale transparent or auto advanced settings", async () => {
    for (const background of ["transparent", "auto"])
      expect(await promptImageBackground(scene(), target, () => source("knit"), { background })).toEqual({ background: "opaque" });
    expect(await promptImageBackground(scene({ scene: "pattern-colorway" }), { ...target, modelId: "gemini-nano-banana-2.1" }, () => source("knit"), { background: "transparent" })).toEqual({});
  });
  test("colorway supports multiple references using only primary art and keeps WebP choice", async () => {
    expect(await promptImageBackground(scene({ scene: "pattern-colorway", referenceRoles: ["主图", "配色参考"] }), target, () => source("flower"), { output_format: "webp" })).toEqual({ background: "transparent", output_format: "webp" });
  });
  test("transparent JPEG and unsupported routes stop before image submission", async () => {
    await expect(promptImageBackground(scene(), target, () => source("flower"), { output_format: "jpeg" })).rejects.toMatchObject({ code: "IMAGE_TRANSPARENCY_FORMAT_CONFLICT" });
    for (const variant of [{ ...target, modelId: "gemini-nano-banana-2.1" }, { ...target, modelId: "gpt-image-2" }, { ...target, workflowConfigId: "workflow" }])
      await expect(promptImageBackground(scene(), variant, () => source("flower"), {})).rejects.toMatchObject({ code: "IMAGE_TRANSPARENCY_UNSUPPORTED" });
  });
  test("unrelated scenes and masked edits retain explicit settings", async () => {
    for (const input of [scene({ scene: "garment-colorway" }), scene({ mode: "generate" }), scene({ hasMask: true })])
      expect(await promptImageBackground(input, target, async () => { throw Error("must not read"); }, { background: "auto" })).toEqual({ background: "auto" });
  });
  test("task integration resolves independent inputs from their own authorized primary source", async () => {
    const reads: string[] = [];
    const compiler = { compile: async () => ({ id: "compiled", status: "success", prompt: "Recolor Image 1.", optimized: true }), runtime: {
      resolveTarget: async () => target, readSource: async (actor: any, url: string) => { expect(actor.id).toBe("owner"); reads.push(url); return source(url === "transparent" ? "flower" : "knit"); },
    } } as unknown as PromptCompiler;
    const input = { requestId: "artwork-item", operationType: "inpaint", modelConfigId: "flare", prompt: "change colors", promptInput: scene({ scene: "pattern-colorway" }), parameters: {} as Record<string, unknown>, sourceUrls: ["transparent", "palette"] };
    const transparent = await preparePromptTaskInput(compiler, { id: "owner", role: "designer" }, input);
    const opaque = await preparePromptTaskInput(compiler, { id: "owner", role: "designer" }, { ...input, sourceUrls: ["opaque", "palette"] });
    expect(transparent.parameters.background).toBe("transparent"); expect(opaque.parameters.background).toBe("opaque"); expect(reads).toEqual(["transparent", "opaque"]);
  });
  test("invalid source decoding reports a definite input error rather than an ambiguous server failure", async () => {
    await expect(promptImageBackground(scene(), target, async () => ({ bytes: new Uint8Array([1]), mimeType: "image/png", previewDataUrl: "" }), {}))
      .rejects.toMatchObject({ code: "IMAGE_INPUT_INSPECTION_FAILED", status: 422 });
  });
});
