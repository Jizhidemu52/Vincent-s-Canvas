import { describe, expect, test } from "bun:test";
import { createReferenceImportService, detectReferenceImage, extractReferenceCandidates, sanitizeSourceUrl, type ReferenceFetcher } from "../src/reference-import";
import { isPublicAddress, resolvePublicAddress, validatePublicUrl } from "../src/reference-import/public-fetch.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==", "base64");
const html = '<title>网页 &amp; 标题</title><img alt="原始图片" src="/image.png?token=private#x"><img src="/second.png">';
const fixture: ReferenceFetcher = async (url, kind) => ({ bytes: kind === "html" ? Buffer.from(html) : png, mime: kind === "html" ? "text/html" : "image/png", finalUrl: url });

describe("reference import SSRF syntax and DNS policy", () => {
  for (const url of ["file:///etc/passwd", "data:text/html,x", "ftp://example.com/", "https://user:pass@example.com/", "https://example.com:8443/", "http://example.com:443/", "http://localhost/", "http://localhost./", "http://foo.local/", "http://metadata.google.internal/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/", "http://0/", "http://169.254.169.254/", "http://100.100.100.200/", "http://192.168.1.2/", "http://10.1.1.1/", "http://172.31.255.255/", "http://198.18.1.1/", "http://[::1]/", "http://[::ffff:8.8.8.8]/", "http://[::ffff:127.0.0.1]/", "http://[fe80::1]/", "http://[fd00:ec2::254]/", "http://[2001:db8::1]/", "http://[2002::1]/", "http://[3fff::1]/", "https://example.com\\@127.0.0.1/", "http://example.com/\r\nX:1", " http://example.com/"]) test(`rejects ${JSON.stringify(url)}`, () => expect(() => validatePublicUrl(url)).toThrow());
  test("accepts only public literal addresses and normalizes standard ports", () => {
    expect(validatePublicUrl("https://example.com:443/image?q=1#x").href).toBe("https://example.com/image?q=1");
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPublicAddress(ip)).toBe(true);
    expect(isPublicAddress("168.63.129.16")).toBe(false);
  });
  test("one unsafe address in mixed A/AAAA DNS rejects the whole host", async () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "::1", "::ffff:8.8.8.8", "fd00::1"]) {
      await expect(resolvePublicAddress(new URL("https://example.com"), async () => [{ address: "8.8.8.8", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }])).rejects.toMatchObject({ code: "UNSAFE_ADDRESS" });
    }
  });
  test("all-public DNS selects a fixed checked IP; DNS failures and empty answers fail closed", async () => {
    expect(await resolvePublicAddress(new URL("https://example.com"), async () => [{ address: "1.1.1.1", family: 4 }, { address: "8.8.8.8", family: 4 }])).toEqual({ address: "1.1.1.1", family: 4 });
    await expect(resolvePublicAddress(new URL("https://example.com"), async () => [])).rejects.toMatchObject({ code: "UNSAFE_ADDRESS" });
    await expect(resolvePublicAddress(new URL("https://example.com"), async () => { throw new Error("secret DNS details"); })).rejects.toMatchObject({ code: "DNS_FAILED", message: "无法解析网页地址" });
  });
});

describe("HTML extraction", () => {
  test("parses HTML entities, base, lazy attributes, picture srcset and OG; deduplicates", () => {
    const result = extractReferenceCandidates(`<title>A &amp; B</title><base href="/assets/"><img alt="first" src="a.png?x=1&amp;y=2" data-src="lazy.png"><img src="a.png?x=1&amp;y=2"><picture><source srcset="small.webp 1x, large.webp 2x"><img currentsrc="current.jpg" data-original="original.gif" srcset="wide.jpg 1000w"></picture><meta property="og:image" content="../og.png"><img src="data:image/png;base64,abc"><img src="http://127.0.0.1/private">`, "https://example.com/path/page?secret=1");
    expect(result.pageTitle).toBe("A & B");
    expect(result.candidates.map((item) => item.url)).toEqual(["https://example.com/assets/lazy.png", "https://example.com/assets/a.png?x=1&y=2", "https://example.com/assets/small.webp", "https://example.com/assets/large.webp", "https://example.com/assets/current.jpg", "https://example.com/assets/original.gif", "https://example.com/assets/wide.jpg", "https://example.com/og.png"]);
    expect(result.candidates[1]!.sourceImage).toBe("https://example.com/assets/a.png");
    expect(new Set(result.candidates.map((item) => item.id)).size).toBe(8);
  });
  test("caps at 20; invalid base cannot point into private network", () => {
    const result = extractReferenceCandidates('<base href="http://127.0.0.1/">' + Array.from({ length: 25 }, (_, i) => `<img src="${i}.png">`).join(""), "https://example.com/path/");
    expect(result.candidates).toHaveLength(20);
    expect(result.candidates[0]!.url).toBe("https://example.com/path/0.png");
    expect(result.warnings).toHaveLength(1);
  });
  test("does not execute scripts; no-candidate guidance; sanitized URL removes credentials/query/hash", () => {
    expect(extractReferenceCandidates('<script>document.write("<img src=a.png>")</script>', "https://example.com/").candidates).toHaveLength(0);
    expect(extractReferenceCandidates("", "https://example.com/").warnings[0]).toContain("浏览器扩展");
    expect(sanitizeSourceUrl("https://user:secret@example.com/x?token=sensitive#hash")).toBe("https://example.com/x");
  });
});

describe("reference import owner/cache/limits", () => {
  test("original bytes preserved; raw signed URL stays server-side; owner/candidate binding and cached idempotency", async () => {
    const calls: string[] = [];
    const service = createReferenceImportService({ fetcher: async (...args) => { calls.push(args[0]); return fixture(...args); } });
    try {
      const scan = await service.scan("employee-a", "https://example.com/page?session=hidden#fragment");
      expect(scan.pageUrl).toBe("https://example.com/page");
      expect(JSON.stringify(scan)).not.toContain("private"); expect(JSON.stringify(scan)).not.toContain("hidden");
      const id = scan.candidates[0]!.id;
      await expect(service.image("employee-b", scan.scanId, id)).rejects.toMatchObject({ status: 404 });
      await expect(service.image("employee-a", scan.scanId, "https://example.com/anything.png")).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
      const image = await service.image("employee-a", scan.scanId, id);
      expect(Buffer.from(image.base64, "base64")).toEqual(png);
      expect(image.sourcePage).toBe("https://example.com/page"); expect(image.sourceImage).toBe("https://example.com/image.png");
      expect(calls[1]).toBe("https://example.com/image.png?token=private");
      expect(await service.image("employee-a", scan.scanId, id)).toEqual(image); expect(calls).toHaveLength(2);
    } finally { service.dispose(); }
  });
  test("TTL expires and image bytes are released for another scan", async () => {
    let time = 1_000;
    const service = createReferenceImportService({ fetcher: fixture, now: () => time, ttlMs: 20, maxCacheBytes: png.length });
    try {
      const first = await service.scan("a", "https://example.com/");
      await service.image("a", first.scanId, first.candidates[0]!.id);
      time += 21;
      await expect(service.image("a", first.scanId, first.candidates[0]!.id)).rejects.toMatchObject({ code: "SCAN_NOT_FOUND" });
      const second = await service.scan("a", "https://example.com/");
      expect((await service.image("a", second.scanId, second.candidates[0]!.id)).mime).toBe("image/png");
    } finally { service.dispose(); }
  });
  test("scan/global byte ceilings cannot be bypassed by repeated or concurrent IDs", async () => {
    for (const options of [{ maxScanBytes: png.length, code: "SCAN_BYTES_LIMIT" }, { maxCacheBytes: png.length, code: "CACHE_FULL" }]) {
      const service = createReferenceImportService({ fetcher: fixture, ...options });
      try {
        const scan = await service.scan("a", "https://example.com/");
        const results = await Promise.allSettled(scan.candidates.map((candidate) => service.image("a", scan.scanId, candidate.id)));
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.code).toBe(options.code);
        const index = results.findIndex((result) => result.status === "fulfilled");
        await expect(service.image("a", scan.scanId, scan.candidates[index]!.id)).resolves.toHaveProperty("mime", "image/png");
      } finally { service.dispose(); }
    }
  });
  test("HTML and image decoded size caps plus type/magic validation", async () => {
    for (const [kind, bytes, mime, code] of [["html", Buffer.alloc(2 * 1024 * 1024 + 1), "text/html", "BODY_TOO_LARGE"], ["html", Buffer.from("x"), "text/plain", "UNSUPPORTED_TYPE"], ["image", Buffer.alloc(10 * 1024 * 1024 + 1), "image/png", "BODY_TOO_LARGE"], ["image", Buffer.from("<svg/>"), "image/png", "UNSUPPORTED_TYPE"], ["image", png, "image/jpeg", "UNSUPPORTED_TYPE"]] as const) {
      const service = createReferenceImportService({ fetcher: async (url, requested, signal) => requested === kind ? { bytes, mime, finalUrl: url } : fixture(url, requested, signal) });
      try {
        if (kind === "html") await expect(service.scan("a", "https://example.com/")).rejects.toMatchObject({ code });
        else { const scan = await service.scan("a", "https://example.com/"); await expect(service.image("a", scan.scanId, scan.candidates[0]!.id)).rejects.toMatchObject({ code }); }
      } finally { service.dispose(); }
    }
    expect(detectReferenceImage(Buffer.from([255, 216, 255, 0]))).toBe("image/jpeg");
    expect(detectReferenceImage(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(detectReferenceImage(Buffer.from("RIFFxxxxWEBP"))).toBe("image/webp");
  });
  test("owner/global rate limits and bounded scan entries", async () => {
    for (const [limits, secondOwner, code] of [[{ maxScansPerMinute: 1 }, "a", "SCAN_RATE_LIMIT"], [{ maxGlobalScansPerMinute: 1 }, "b", "SCAN_RATE_LIMIT"], [{ maxScans: 1 }, "b", "SCAN_LIMIT"], [{ maxOwnerScans: 1 }, "a", "SCAN_LIMIT"]] as const) {
      const service = createReferenceImportService({ fetcher: fixture, ...limits });
      try { await service.scan("a", "https://example.com/"); await expect(service.scan(secondOwner, "https://example.com/")).rejects.toMatchObject({ code }); }
      finally { service.dispose(); }
    }
  });
  test("cancellation frees owner/global concurrency; no expired pending result is stored", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let shouldWait = true;
    const service = createReferenceImportService({ maxConcurrent: 1, fetcher: async (url, kind, signal) => {
      if (shouldWait) { started(); await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancel")), { once: true })); }
      return fixture(url, kind, signal);
    } });
    try {
      const controller = new AbortController(); const first = service.scan("a", "https://example.com/", controller.signal);
      await ready;
      await expect(service.scan("b", "https://example.com/")).rejects.toMatchObject({ code: "IMPORT_BUSY" });
      controller.abort(); await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
      shouldWait = false; expect((await service.scan("a", "https://example.com/")).candidates).toHaveLength(2);
      await expect(service.scan("a", "https://example.com/", AbortSignal.abort())).rejects.toMatchObject({ code: "CANCELLED" });
    } finally { service.dispose(); }
  });
});
