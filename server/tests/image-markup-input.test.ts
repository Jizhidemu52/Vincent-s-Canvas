import { expect, test } from "bun:test";
import { prepareImageEditInput } from "../src/image-edit-input";
import { stepApiMartImageTask } from "../src/apimart-image";
import { taskSubmissionSchema } from "../../shared/task-contracts";

const rgba = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8////fwYGBgYWEAHCAD4KBAICIHhuAAAAAElFTkSuQmCC", "base64");
const rgb = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAE0lEQVR4nGP8//8/AwMDCwMYAAAkFAMDuxa40wAAAABJRU5ErkJggg==", "base64");
const wide = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFElEQVR4nGP8////fwYkwILMAbEBfgoEAu8AY9wAAAAASUVORK5CYII=", "base64");
const source = { bytes: rgba, mimeType: "image/png", filename: "source.png" };
const layer = { bytes: rgba, mimeType: "image/png", filename: "markup.png" };
const target = { protocol: "apimart", modelId: "gpt-image-2.6-flare", operationType: "inpaint" };
const parameters = { inputArchive: { markupReferenceIndex: 1 } };

test("owned markup is removed from ordinary references without changing bytes or order", async () => {
  const last = { ...source, filename: "other.png" };
  const result = await prepareImageEditInput([source, layer, last], parameters, target);
  expect(result.references).toEqual([source, last]);
  expect((result as typeof result & { markup?: typeof layer }).markup).toBe(layer);
  expect(result.mask).toBeUndefined();
});

test("invalid markup is rejected before upload or generation", async () => {
  for (const [sources, settings, model] of [
    [[source, layer], { inputArchive: { markupReferenceIndex: 0 } }, target],
    [[source], parameters, target],
    [[source, layer], { inputArchive: { markupReferenceIndex: 1, maskReferenceIndex: 1 } }, target],
    [[source, layer], { ...parameters, output_format: "gif" }, target],
    [[source, layer], parameters, { ...target, modelId: "gpt-image-2.5-flare" }],
    [[source, layer], parameters, { ...target, workflow: true }],
    [[source, { ...layer, bytes: rgb }], parameters, target],
    [[source, { ...layer, bytes: wide }], parameters, target],
    [[source, { ...layer, mimeType: "image/jpeg" }], parameters, target],
    [[source, { ...layer, bytes: new Uint8Array(50 * 1024 * 1024 + 1) }], parameters, target],
  ] as const) await expect(prepareImageEditInput([...sources], settings, model)).rejects.toThrow();
});

test("worker-ready annotation becomes markup_url only and never a second reference", async () => {
  const result = await prepareImageEditInput([source, layer], parameters, target);
  const requests: string[] = [];
  const request = await stepApiMartImageTask({ modelId: target.modelId, prompt: "Follow the circle", parameters,
    sourceImages: result.references, markupImage: (result as typeof result & { markup?: typeof layer }).markup,
    baseUrl: "https://provider.example/v1", apiKey: "test-only" }, {
    fetch: async (url, init) => {
      requests.push(url);
      if (url.endsWith("/uploads/images")) return Response.json({ url: "https://images.example/source.png" });
      const body = JSON.parse(String(init?.body));
      expect(body.image_urls).toEqual(["https://images.example/source.png"]);
      expect(body.markup_url).toBe(`data:image/png;base64,${rgba.toString("base64")}`);
      expect(body).not.toHaveProperty("inputArchive");
      return Response.json({ data: [{ task_id: "markup-paid-once" }] });
    },
  });
  expect(request.status).toBe("pending");
  expect(requests).toHaveLength(2);
});

test("sixteen ordinary references plus one markup pass total-source schema and provider reference limit", async () => {
  const sources = [...Array.from({ length: 16 }, (_, index) => ({ ...source, filename: `reference-${index}.png` })), layer];
  const settings = { inputArchive: { markupReferenceIndex: 16 } };
  const sourceUrls = sources.map(() => `/api/assets/${crypto.randomUUID()}/content`);
  expect(taskSubmissionSchema.parse({ requestId: crypto.randomUUID(), projectId: crypto.randomUUID(), operationType: "image_generation", prompt: "follow annotations", parameters: settings, sourceUrls }).sourceUrls).toHaveLength(17);
  const prepared = await prepareImageEditInput(sources, settings, target);
  let uploads = 0, submissions = 0;
  await stepApiMartImageTask({ modelId: target.modelId, prompt: "follow annotations", parameters: settings,
    sourceImages: prepared.references, markupImage: prepared.markup, baseUrl: "https://provider.example/v1", apiKey: "test-only" }, {
    fetch: async (url, init) => {
      if (url.endsWith("/uploads/images")) return Response.json({ url: `https://images.example/${++uploads}.png` });
      submissions++;
      const body = JSON.parse(String(init?.body));
      expect(body.image_urls).toHaveLength(16);
      expect(body.markup_url).toStartWith("data:image/png;base64,");
      return Response.json({ data: [{ task_id: "sixteen-plus-markup" }] });
    },
  });
  expect(uploads).toBe(16); expect(submissions).toBe(1);
});
