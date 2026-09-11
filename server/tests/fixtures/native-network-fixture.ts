import { fileURLToPath } from "node:url";

export type NativeNetworkEvent = {
  event: string;
  targetPort?: number;
  proxyPort?: number;
  connects: number;
  requests: number;
  connections: number;
  closedConnections: number;
  method?: string;
  headers?: Record<string, string>;
  headBytes?: number;
  authorization?: string;
  proxyAuthorization?: string;
  body?: string;
};

export async function startNativeNetworkFixture(input: { cert: string; key: string }) {
  const fixture = Bun.spawn([Bun.which("node")!, fileURLToPath(new URL("./provider-network-fixture.mjs", import.meta.url))], {
    stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe", env: { ...process.env },
  });
  const stderr = new Response(fixture.stderr).text();
  const reader = fixture.stdout.getReader();
  const decoder = new TextDecoder();
  const events: NativeNetworkEvent[] = [];
  const waiters = new Set<{ accept: (event: NativeNetworkEvent) => boolean; resolve: (event: NativeNetworkEvent) => void; reject: (error: Error) => void }>();
  let stopped = false;
  let failure: Error | undefined;
  const received = (async () => {
    let buffered = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value, { stream: true });
        while (buffered.includes("\n")) {
          const separator = buffered.indexOf("\n");
          const event = JSON.parse(buffered.slice(0, separator)) as NativeNetworkEvent;
          buffered = buffered.slice(separator + 1);
          events.push(event);
          for (const waiter of waiters) if (waiter.accept(event)) waiter.resolve(event);
        }
      }
      if (!stopped) throw new Error(`Native network fixture exited (${await fixture.exited}): ${await stderr}`);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      for (const waiter of waiters) waiter.reject(failure);
    }
  })();
  const waitFor = (accept: (event: NativeNetworkEvent) => boolean, timeoutMs: number) => {
    const existing = events.find(accept);
    if (existing) return Promise.resolve(existing);
    if (failure) return Promise.reject(failure);
    return new Promise<NativeNetworkEvent>((resolve, reject) => {
      const cleanup = () => { clearTimeout(deadline); waiters.delete(waiter); };
      const waiter = {
        accept,
        resolve: (event: NativeNetworkEvent) => { cleanup(); resolve(event); },
        reject: (error: Error) => { cleanup(); reject(error); },
      };
      const deadline = setTimeout(() => waiter.reject(new Error(`Native network fixture event timed out; events=${JSON.stringify(events)}`)), timeoutMs);
      waiters.add(waiter);
    });
  };
  const close = async () => {
    stopped = true;
    fixture.kill();
    await reader.cancel().catch(() => {});
    await fixture.exited;
    await received;
    await stderr;
  };
  try {
    const ready = await waitFor((event) => event.event === "listening", 3_000);
    return { ready, events, waitFor, close };
  } catch (error) { await close(); throw error; }
}
