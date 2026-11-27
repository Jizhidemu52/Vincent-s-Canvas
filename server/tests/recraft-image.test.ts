import { expect, spyOn, test } from "bun:test";
import { runRecraftImage, assertRecraftVector, downloadRecraftResult, isRecraftResult } from "../src/recraft-image";
import { assetResponseHeaders, validateAssetUpload } from "../src/asset-delivery";

const source = { mimeType: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAQAAAAEAAQAAAAB0CZXLAAAAH0lEQVR4nO3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAvg0hAAAB8Wch7gAAAABJRU5ErkJggg==", "base64") };
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" style="display: block;"><path d="M0 0h10v10z"/></svg>');

test("Vectorizer Pro garment gradients retain their editable color stops", () => {
  const gradient = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="wool"><stop class="color-stop" offset="0" stop-opacity="1" stop-color="#224466"/></linearGradient></defs><path fill="url(#wool)" d="M0 0h10v10z"/></svg>');
  expect(() => assertRecraftVector(gradient)).not.toThrow();
});

test("vectorize submits exactly one Pro request and preserves SVG bytes", async () => {
  const stages: string[] = [];
  const image = { image_id: "12d34a56-7b78-4c90-8d12-34567890abcd", url: "https://img.recraft.ai/result.svg" };
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(url).toBe(image.url);
    expect(init?.headers).toBeUndefined();
    stages.push("download");
    return new Response(svg);
  }, { preconnect: fetch.preconnect }));
  try {
    const submit = async (url: string | URL, init: RequestInit) => {
      expect(String(url)).toBe("https://external.api.recraft.ai/v1/images/vectorize");
      expect(init.method).toBe("POST");
      const body = init.body as FormData;
      expect(body.get("version")).toBe("v1_pro");
      expect(body.get("response_format")).toBe("url");
      expect(Buffer.from(await (body.get("file") as File).arrayBuffer())).toEqual(source.bytes);
      stages.push("submit");
      return Response.json({ image });
    };
    const got = await runRecraftImage("vectorize", source, async () => { stages.push("claim"); }, "fixture", async receipt => {
      expect(receipt).toEqual(image);
      stages.push("saved");
    }, submit);
    expect(got).toEqual({ mimeType: "image/svg+xml", bytes: svg });
    expect(stages).toEqual(["claim","submit","saved","download"]);
  } finally { fetchMock.mockRestore(); }
});

test("only verified generated SVG is delivered inline and SVG uploads remain blocked", async () => {
  expect(() => assertRecraftVector(svg)).not.toThrow();
  for (const tag of ['<script/>', '<image href="https://example.com/img.png"/>', '<path onload="run()"/>']) {
    expect(() => assertRecraftVector(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">' + tag + '</svg>'))).toThrow();
  }
  expect(assetResponseHeaders("image/svg+xml", "drawing.svg", false, true)["content-type"]).toBe("image/svg+xml");
  expect(assetResponseHeaders("image/svg+xml", "upload.svg")["content-type"]).toBe("application/octet-stream");
  await expect(validateAssetUpload(svg, "image/svg+xml")).rejects.toThrow();
});

test("saved Recraft results recover by download alone and reject unexpected origins", async () => {
  const id = "12d34a56-7b78-4c90-8d12-34567890abcd";
  for (const url of ["http://img.recraft.ai/a","https://example.com/a","https://user@img.recraft.ai/a"]) {
    expect(isRecraftResult({ image_id: id, url })).toBe(false);
  }
  const urls: string[] = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return urls.length === 1 ? new Response("",{ status:503 }) : new Response(source.bytes);
  }, { preconnect: fetch.preconnect }));
  try {
    const image = { image_id: id, url: "https://img.recraft.ai/hat" };
    await expect(downloadRecraftResult("hd-upscale", image)).rejects.toMatchObject({code:"RESULT_DOWNLOAD_FAILED"});
    expect((await downloadRecraftResult("hd-upscale", image)).bytes).toEqual(source.bytes);
    expect(urls).toEqual([image.url,image.url]);
  } finally { fetchMock.mockRestore(); }
});
