import { fetchPublicResource, PublicFetchError } from "./public-fetch.mjs";

try {
  if (process.versions.bun) throw new PublicFetchError(503, "NATIVE_NODE_REQUIRED", "网页采集需要原生 Node.js 运行环境");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 16384) throw new PublicFetchError(400, "INVALID_URL", "链接过长");
  }
  const { url, kind } = JSON.parse(input);
  if (!["html", "image"].includes(kind)) throw new Error("Invalid resource kind");
  const result = await fetchPublicResource(url, { kind, maxBytes: (kind === "html" ? 2 : 10) * 1024 * 1024, signal: AbortSignal.timeout(15_000) });
  process.stdout.write(`${JSON.stringify({ finalUrl: result.finalUrl, mime: result.mime })}\n`);
  process.stdout.end(result.bytes);
} catch (error) {
  // Do not reveal original URLs, signed queries, socket addresses or credentials.
  const details = error instanceof PublicFetchError ? { status: error.status, code: error.code, message: error.message } : { status: error?.name === "TimeoutError" || error?.name === "AbortError" ? 504 : 502, code: "FETCH_FAILED", message: "无法获取公开网页内容（网络、证书或超时），可使用浏览器扩展采集" };
  process.stdout.end(`${JSON.stringify({ error: details })}\n`);
  process.exitCode = 1;
}
