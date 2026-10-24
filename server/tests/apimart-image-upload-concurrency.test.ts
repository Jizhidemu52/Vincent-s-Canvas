import { expect, test } from "bun:test";
import { stepApiMartImageTask } from "../src/apimart-image";

const input = { baseUrl: "https://provider.example/v1", apiKey: "fixture-only", modelId: "gpt-image-2.5-flare", prompt: "product", parameters: {} };
const inline = (id: number) => `data:image/png;base64,${Buffer.from([id]).toString("base64")}`;
const uploadedUrl = (id: number) => `https://images.example/reference-${id}.png`;
const nextTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function uploads() {
  const gates = new Map<number, ReturnType<typeof Promise.withResolvers<Response>>>();
  const started: number[] = [], submitted: Record<string, unknown>[] = [];
  let active = 0, peak = 0, cleanup = false;
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/images/generations")) {
      submitted.push(JSON.parse(String(init?.body)));
      expect(active).toBe(0);
      return Response.json({ data: [{ task_id: "generated-once" }] });
    }
    expect(url).toEndWith("/uploads/images");
    expect(init?.method).toBe("POST");
    const file = (init?.body as FormData).get("file") as File;
    const id = new Uint8Array(await file.arrayBuffer())[0]!;
    started.push(id); active++; peak = Math.max(peak, active);
    const gate = Promise.withResolvers<Response>(); gates.set(id, gate);
    if (cleanup) gate.resolve(Response.json({ url: uploadedUrl(id) }));
    try { return await gate.promise; } finally { active--; }
  };
  return { fetch, gates, started, submitted, active: () => active, peak: () => peak,
    release: (id: number) => gates.get(id)!.resolve(Response.json({ url: uploadedUrl(id) })),
    cleanup: () => { cleanup = true; for (const [id, gate] of gates) gate.resolve(Response.json({ url: uploadedUrl(id) })); },
  };
}

test("image reference uploads run at most three at once and retain input order after out-of-order completion", async () => {
  const h = uploads();
  const publicUrl = "https://images.example/already-uploaded.png";
  let claims = 0;
  const pending = stepApiMartImageTask({ ...input, sourceDataUrls: [inline(1), publicUrl, inline(2), inline(3), inline(4), inline(5)],
    beforeSubmit: () => { expect(h.active()).toBe(0); claims++; },
  }, { fetch: h.fetch });
  try {
    await nextTurn(); expect(h.started).toEqual([1, 2, 3]); expect(h.active()).toBe(3);
    h.release(3); await nextTurn(); expect(h.started).toEqual([1, 2, 3, 4]);
    h.release(1); await nextTurn(); expect(h.started).toEqual([1, 2, 3, 4, 5]);
    h.release(5); h.release(2); h.release(4);
    expect(await pending).toMatchObject({ status: "pending", upstreamTaskId: "generated-once" });
    expect(h.peak()).toBe(3); expect(h.active()).toBe(0); expect(claims).toBe(1);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.image_urls).toEqual([uploadedUrl(1), publicUrl, uploadedUrl(2), uploadedUrl(3), uploadedUrl(4), uploadedUrl(5)]);
  } finally { h.cleanup(); await pending.catch(() => {}); }
});

test("one failed upload stops unstarted references, drains already-started uploads and never claims or submits generation", async () => {
  const h = uploads(); let settled = false, claims = 0;
  const pending = stepApiMartImageTask({ ...input, sourceDataUrls: [1, 2, 3, 4, 5, 6, 7].map(inline), beforeSubmit: () => { claims++; } }, { fetch: h.fetch });
  const observed = pending.then(value => { settled = true; return value; }, error => { settled = true; return error; });
  try {
    await nextTurn(); expect(h.started).toEqual([1, 2, 3]);
    h.gates.get(1)!.resolve(Response.json({}, { status: 503 }));
    await nextTurn(); expect(settled).toBe(false); expect(h.active()).toBe(2); expect(h.started).toEqual([1, 2, 3]);
    expect(claims).toBe(0); expect(h.submitted).toHaveLength(0);
    h.release(2); await nextTurn(); expect(settled).toBe(false); expect(h.active()).toBe(1);
    h.gates.get(3)!.reject(new Error("Second in-flight upload failed"));
    expect(await observed).toMatchObject({ message: "APIMart 参考图上传失败（503），尚未提交图片生成" });
    expect(settled).toBe(true); expect(h.active()).toBe(0); expect(h.started).toEqual([1, 2, 3]);
    expect(h.peak()).toBe(3); expect(claims).toBe(0); expect(h.submitted).toHaveLength(0);
  } finally { h.cleanup(); await observed; }
});

test.each(["resolved", "rejected"])("non-2xx upload response cancellation is awaited and preserves the original failure when %s", async cancellation => {
  const gate = Promise.withResolvers<void>();
  let cancelled = false, settled = false, claims = 0;
  const requests: string[] = [];
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; return gate.promise; } }), { status: 503 });
  const observed = stepApiMartImageTask({ ...input, sourceDataUrls: [inline(1)], beforeSubmit: () => { claims++; } }, {
    fetch: async url => { requests.push(url); return response; },
  }).then(value => { settled = true; return value; }, error => { settled = true; return error; });
  try {
    await nextTurn();
    expect(cancelled).toBe(true);
    expect(settled).toBe(false);
    if (cancellation === "rejected") gate.reject(new Error("Cancellation fixture failure"));
    else gate.resolve();
    expect(await observed).toMatchObject({ message: "APIMart 参考图上传失败（503），尚未提交图片生成" });
    expect(requests).toEqual(["https://provider.example/v1/uploads/images"]);
    expect(claims).toBe(0);
  } finally { gate.resolve(); await observed; await response.body?.cancel().catch(() => {}); }
});
