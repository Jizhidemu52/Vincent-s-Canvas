import { expect, test } from "bun:test";
import { prepareVideoProviderSources } from "../src/video-source-preparation";

const nextTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const source = (id: number) => ({ mimeType: "image/png", bytes: new Uint8Array([id]), width: 768, height: 768 });
const input = { model: "doubao-seedance-2.5" as const, prompt: "fixture reference", parameters: { videoMode: "reference" }, baseUrl: "https://provider.invalid/v1", apiKey: "fixture-only" };

test.each([false, true])("video image uploads preserve ordering with three active uploads and failure draining (%s)", async failure => {
  const gates = new Map<number, ReturnType<typeof Promise.withResolvers<Response>>>();
  const started: number[] = []; let active = 0, peak = 0, settled = false;
  let cleanup = false;
  const fetch = async (_url: string, init?: RequestInit) => {
    const id = new Uint8Array(await ((init!.body as FormData).get("file") as File).arrayBuffer())[0]!;
    active++; peak = Math.max(peak, active); started.push(id);
    const gate = Promise.withResolvers<Response>(); gates.set(id, gate);
    if (cleanup) gate.resolve(Response.json({ url: `https://owned.example/${id}.png` }));
    try { return await gate.promise; } finally { active--; }
  };
  const pending = prepareVideoProviderSources({ ...input, sources: [1, 2, 3, 4, 5].map(source) }, { fetch });
  const observed = pending.then(value => { settled = true; return value; }, error => { settled = true; return error; });
  const release = (id: number) => gates.get(id)!.resolve(Response.json({ url: `https://owned.example/${id}.png` }));
  try {
    await nextTurn(); expect(started).toEqual([1, 2, 3]); expect(active).toBe(3);
    if (failure) {
      gates.get(1)!.resolve(Response.json({}, { status: 503 })); await nextTurn();
      expect(settled).toBe(false); expect(started).toEqual([1, 2, 3]);
      release(2); release(3); expect(await observed).toBeInstanceOf(Error); expect(started).toEqual([1, 2, 3]);
    } else {
      release(3); await nextTurn(); expect(started).toEqual([1, 2, 3, 4]);
      release(1); await nextTurn(); expect(started).toEqual([1, 2, 3, 4, 5]);
      release(5); release(4); release(2);
      expect((await observed).map((item: { publicUrl: string }) => item.publicUrl)).toEqual([1, 2, 3, 4, 5].map(id => `https://owned.example/${id}.png`));
    }
    expect(peak).toBe(3); expect(active).toBe(0);
  } finally { cleanup = true; for (const id of gates.keys()) release(id); await observed; }
});

test("invalid final video reference prevents even the first upload", async () => {
  let uploads = 0;
  await expect(prepareVideoProviderSources({ ...input, sources: [source(1), { ...source(2), mimeType: "image/svg+xml" }] }, { fetch: async () => { uploads++; return Response.json({}); } })).rejects.toThrow();
  expect(uploads).toBe(0);
});
