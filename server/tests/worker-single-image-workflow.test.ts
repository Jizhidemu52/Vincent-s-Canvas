import { expect, test } from "bun:test";
import ts from "typescript";
import { singleImageTaskParameters } from "../src/image-task-policy";
import { internalAiRequestTemplate, internalAiSeamlessDefaults } from "../src/routes/internal-ai-configuration";
import { normalizeWorkflowOutputs, parsePromptVariables, readPath, renderTemplate } from "../src/workflow-runtime";

const file = new URL("../src/worker.ts", import.meta.url);
const source = ts.createSourceFile(file.pathname, await Bun.file(file).text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ["executeWorkflow", "isImageWorkflowTask", "singleImageWorkflowRequestBody", "isBuiltinSingleImageWorkflow"];
const code = ts.transpileModule(source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || ""))
  .map(node => node.getText(source)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const posts: Record<string, unknown>[] = [];
  const deps = {
    loadSourceAssets: async () => [{ bytes: new Uint8Array([1]), mimeType: "image/png" }, { bytes: new Uint8Array([2]), mimeType: "image/png" }],
    renderTemplate, parsePromptVariables, readPath, normalizeWorkflowOutputs,
    claimProviderSubmission: async () => {},
    assertProviderSubmissionResponse: async (response: Response) => { if (!response.ok) throw new Error(`Provider ${response.status}`); },
    joinUrl: (base: string, path: string) => base + path,
    fetchProviderResult: async () => ({ bytes: new Uint8Array([1]), mimeType: "image/png" }),
    fetch: async (_url: string, init: RequestInit) => {
      posts.push(JSON.parse(String(init.body)));
      return Response.json({ outputs: ["https://fixture.invalid/result.png"], data: { data: { list: ["https://fixture.invalid/result.png"] } } });
    },
  };
  const execute = new Function(...Object.keys(deps), `${code};return executeWorkflow;`)(...Object.values(deps));
  const task = (overrides: Record<string, unknown> = {}) => ({
    id: "offline-task", operation_type: "image_generation", model_id: "gpt-image-2", protocol: "custom", source_urls: [], user_id: "owner",
    prompt: "cloth", parameters: singleImageTaskParameters("image_generation"), request_template: { n: "$n", prompt: "$prompt" },
    base_url: "https://fixture.invalid", submit_path: "/images/generations", output_path: "outputs", ...overrides,
  });
  return { posts, execute, task };
}

test.each(["image_generation", "inpaint", "upscale", "batch_image", "seamless_stitch"])("workflow %s locks quantity variables after prompt and credentials without changing stored input", async operation => {
  const h = harness();
  const parameters = singleImageTaskParameters(operation, { quantity: 8 });
  const before = structuredClone(parameters);
  await h.execute(h.task({ operation_type: operation, parameters, prompt: JSON.stringify({ n: 7, count: 7, quantity: 7 }), request_template: { n: "$n", count: "$count", quantity: "$quantity" } }), { n: "6", count: "6", quantity: "6" });
  expect(h.posts).toEqual([{ n: 1, count: 1, quantity: 1 }]);
  expect(parameters).toEqual(before);
});

test.each(["n", "count", "quantity"])("final workflow body locks literal output %s even when it did not use a variable", async key => {
  const h = harness();
  await h.execute(h.task({ request_template: { [key]: 4, prompt: "$prompt" } }), {});
  expect(h.posts).toEqual([{ [key]: 1, prompt: "cloth" }]);
});

test.each([
  { prompt: "$prompt" },
  { n: ["dynamic-node", 0] },
  { n: "$missing" },
  { n: 1, inputs: { batch_size: 4 } },
  { n: 1, num_images: 2 },
  { n: 1, workflowId: "opaque-multi-output-workflow" },
  { n: 1, prompt: { "7": { class_type: "SaveImage", inputs: {} } } },
  { n: 1, requests: [{ prompt: "one" }, { prompt: "two" }] },
  { n: 1, repeat: 2 },
  { n: 1, extra: "--repeat 2" },
  { n: 1, prompt: "cloth --r 2" },
])("unsafe or undeclared image workflow templates fail before the POST: %j", async requestTemplate => {
  const h = harness();
  await expect(h.execute(h.task({ request_template: requestTemplate }), {})).rejects.toThrow("单张");
  expect(h.posts).toEqual([]);
});

test("seed and step counts, metadata, and multiple source references are not image output counts", async () => {
  const h = harness();
  await h.execute(h.task({ request_template: { n: "$n", seed: 42, seedCount: 10, steps: 30, step_count: 50, metadata: { count: 9, n: 4 }, image_urls: "$sourceDataUrls" } }), {});
  expect(h.posts).toEqual([{ n: 1, seed: 42, seedCount: 10, steps: 30, step_count: 50, metadata: { count: 9, n: 4 }, image_urls: ["data:image/png;base64,AQ==", "data:image/png;base64,Ag=="] }]);
});

test("the actual shipped GPT Image workflow preset still emits one image without extra protocol fields", async () => {
  const panelFile = new URL("../../web/src/pages/admin/components/workflow-management-panel.tsx", import.meta.url);
  const panel = ts.createSourceFile(panelFile.pathname, await Bun.file(panelFile).text(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let templateNode: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node) && node.properties.some(property => ts.isPropertyAssignment(property) && property.name.getText(panel) === "n" && ts.isStringLiteral(property.initializer) && property.initializer.text === "$count")) templateNode = node;
    ts.forEachChild(node, visit);
  };
  visit(panel);
  expect(templateNode).toBeDefined();
  const template = new Function(`return (${templateNode!.getText(panel)});`)();
  const h = harness();
  await h.execute(h.task({ request_template: template }), {});
  expect(h.posts[0]).toEqual({ model: "gpt-image-2", prompt: "cloth", n: 1, size: "1:1", resolution: "1k", image_urls: ["data:image/png;base64,AQ==", "data:image/png;base64,Ag=="] });
});

test("the exact built-in seamless workflow preserves its existing fixed single-image protocol and steps", async () => {
  const h = harness();
  await h.execute(h.task({ model_id: "sflxjj", operation_type: "seamless_stitch", parameters: { ...internalAiSeamlessDefaults }, request_template: internalAiRequestTemplate(), output_path: "data.data.list" }), { appKey: "fixture-only" });
  expect(h.posts).toEqual([{ model_code: "sflxjj", task_id: "offline-task", app_key: "fixture-only", input_image: "AQ==", cut_width: 200, redraw_width: 200, blur_amount: 100, redraw_strength: 1, steps: 12 }]);
});

test("the seamless exception cannot admit extra output controls into an edited template", async () => {
  const h = harness();
  await expect(h.execute(h.task({ model_id: "sflxjj", operation_type: "seamless_stitch", request_template: { ...internalAiRequestTemplate(), num_images: 4 }, output_path: "data.data.list" }), { appKey: "fixture-only" })).rejects.toThrow("单张");
  expect(h.posts).toEqual([]);
});

test.each(["video_generation", "audio_generation", "chat"])("non-image workflow %s keeps the previous request contract unchanged", async operation => {
  const h = harness();
  await h.execute(h.task({ operation_type: operation, parameters: { count: 3, quantity: 4 }, prompt: JSON.stringify({ n: 5 }), request_template: { n: "$n", count: "$count", quantity: "$quantity", workflowId: "existing" } }), {});
  expect(h.posts).toEqual([{ n: 5, count: 3, quantity: 4, workflowId: "existing" }]);
});
