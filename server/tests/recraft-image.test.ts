import { expect, spyOn, test } from "bun:test";
import { runRecraftImage, assertRecraftVector } from "../src/recraft-image";
import { assetResponseHeaders, validateAssetUpload } from "../src/asset-delivery";

const source = { mimeType: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAQAAAAEAAQAAAAB0CZXLAAAAH0lEQVR4nO3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAvg0hAAAB8Wch7gAAAABJRU5ErkJggg==", "base64") };
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" style="display: block;"><path d="M0 0h10v10z"/></svg>');

test("vectorize submits exactly one Pro request and preserves SVG bytes", async () => {
  let claims = 0;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(claims).toBe(1);
    expect(String(url)).toBe("https://external.api.recraft.ai/v1/images/vectorize");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ version: "v1_pro", response_format: "b64_json", image_url: "data:image/png;base64," + source.bytes.toString("base64") });
    return Response.json({ image: { b64_json: svg.toString("base64") } });
  }, { preconnect: fetch.preconnect }));
  try {
    expect(await runRecraftImage("vectorize", source, async () => { claims++; }, "fixture")).toEqual({ mimeType: "image/svg+xml", bytes: svg });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
