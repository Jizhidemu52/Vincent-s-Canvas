// Used only by the isolated local HTTP tests, never by Start-LAN or normal server startup.
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === "https://oa.test/user") {
    const token = new Headers(init?.headers).get("authorization");
    if (token === "Bearer test-a" || token === "Bearer test-a-rotated") return Response.json({ userid: "employee-a", name: "甲" });
    if (token === "Bearer test-b") return Response.json({ userid: "employee-b", name: "乙" });
    return Response.json({ errcode: 401 });
  }
  return realFetch(input, init);
}, { preconnect: realFetch.preconnect }) as typeof fetch;
