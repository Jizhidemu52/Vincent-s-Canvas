import { expect, test } from "bun:test";
import { stepApiMartImageTask } from "../src/apimart-image";

const base = { baseUrl: "https://provider.example/v1", apiKey: "fixture-key", modelId: "gpt-image-2.5-flare", prompt: "原样使用参考图", parameters: {} };

test("raw reference views upload original bytes without including backing-buffer padding", async () => {
  const backing = new Uint8Array([99, 1, 2, 3, 88]);
  const sources = [{ bytes: backing.subarray(1, 4), mimeType: "image/png", filename: "original.png" }, { bytes: new Uint8Array([4, 5]), mimeType: "image/jpeg" }];
  const uploads: Uint8Array[] = []; let payload: any;
  const result = await stepApiMartImageTask({ ...base, sourceImages: sources } as any, { fetch: async (url, init) => {
    if (url.endsWith('/uploads/images')) {
      const file = (init!.body as FormData).get('file') as File;
      uploads.push(new Uint8Array(await file.arrayBuffer()));
      return Response.json({ url: `https://images.example/${uploads.length}.png` });
    }
    payload = JSON.parse(String(init!.body)); return Response.json({ data: [{ task_id: 'raw-images' }] });
  } });
  expect(uploads).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
  expect(payload.image_urls).toEqual(['https://images.example/1.png', 'https://images.example/2.png']);
  expect(result).toMatchObject({ status: 'pending', upstreamTaskId: 'raw-images' });
});

test("legacy inline protocols encode raw image bytes only at the JSON boundary", async () => {
  let payload: any; let requests = 0;
  await stepApiMartImageTask({ ...base, modelId: 'gpt-image-2', sourceImages: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }] } as any, { fetch: async (_url, init) => {
    requests++; payload = JSON.parse(String(init!.body)); return Response.json({ data: [{ task_id: 'inline' }] });
  } });
  expect(requests).toBe(1); expect(payload.image_urls).toEqual(['data:image/png;base64,AQID']);
});

test("raw reference validation completes before any upload or paid claim", async () => {
  let requests = 0, claims = 0;
  await expect(stepApiMartImageTask({ ...base, sourceImages: [{ bytes: new Uint8Array([1]), mimeType: 'image/png' }, { bytes: new Uint8Array(), mimeType: 'image/png' }], beforeSubmit: () => { claims++; } } as any,
    { fetch: async () => { requests++; return Response.json({}); } })).rejects.toThrow('非空');
  expect(requests).toBe(0); expect(claims).toBe(0);
});

test("known upstream IDs do not read raw references or submit another paid job", async () => {
  const input = { ...base, upstreamTaskId: 'saved-job', submissionStarted: true };
  Object.defineProperty(input, 'sourceImages', { get: () => { throw new Error('references must not be loaded'); } });
  const calls: string[] = [];
  const result = await stepApiMartImageTask(input, { fetch: async (url, init) => {
    calls.push(`${init?.method || 'GET'} ${url}`); return Response.json({ data: { status: 'completed', result: { images: [{ url: 'https://images.example/result.png' }] } } });
  } });
  expect(calls).toEqual(['GET https://provider.example/v1/tasks/saved-job']);
  expect(result.status).toBe('completed');
});
