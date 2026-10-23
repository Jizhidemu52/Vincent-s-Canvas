// Isolated demo HTTP tests only. Keep real image decoding, MIME detection and
// result limits, replacing only their explicit byte-download dependency. The
// native downloader's DNS/TLS/SSRF boundary is tested separately over real sockets.
import { mock } from "bun:test";
import { validatePublicUrl } from "../../src/reference-import/public-fetch.mjs";
import { PublicResourceError, type PublicResourceOptions } from "../../src/public-resource";

const actual = await import("../../src/provider-result");
const fetchImage = actual.fetchProviderResult;
const fetchMedia = actual.fetchProviderMediaResult;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const video = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 109, 112, 52, 50]);
let resultRequests = 0;
const download = async (url: string, options: PublicResourceOptions) => {
  validatePublicUrl(url);
  if (url === "https://mark-demo-result.example/original.png" && options.kind === "provider-image") {
    resultRequests++;
    const failureStatus = Number(process.env.DEMO_TEST_RESULT_FAILURE_ONCE);
    if (resultRequests === 1 && [403, 503].includes(failureStatus))
      throw new PublicResourceError(502, "REMOTE_HTTP_ERROR", "Synthetic result download failure", failureStatus);
    return { bytes: png, mime: "image/png", finalUrl: url };
  }
  if (url === "https://mark-demo-result.example/result.mp4" && options.kind === "provider-media")
    return { bytes: video, mime: "video/mp4", finalUrl: url };
  throw new Error("Unexpected result download in isolated demo fixture");
};
mock.module("../../src/provider-result", () => ({
  ...actual,
  fetchProviderResult: (url: string, timing?: Parameters<typeof fetchImage>[1]) => fetchImage(url, timing, download),
  fetchProviderMediaResult: (url: string, timing?: Parameters<typeof fetchMedia>[1]) => fetchMedia(url, timing, download),
}));
