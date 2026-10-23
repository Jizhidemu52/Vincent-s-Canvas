// Isolated demo HTTP tests only: return local bytes for this exact synthetic public URL.
// All provider requests in those tests use an explicitly configured loopback fake server.
export {};
const realFetch = globalThis.fetch;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
let resultRequests = 0;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === "https://mark-demo-result.invalid/original.png") {
    resultRequests++;
    const failureStatus = Number(process.env.DEMO_TEST_RESULT_FAILURE_ONCE);
    if (resultRequests === 1 && [403, 503].includes(failureStatus))
      return new Response("synthetic download failure", { status: failureStatus });
    return new Response(png, { headers: { "content-type": "image/png" } });
  }
  return realFetch(input, init);
}, { preconnect: realFetch.preconnect }) as typeof fetch;
