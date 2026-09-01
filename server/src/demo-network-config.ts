const supportedDemoHosts = new Set(["127.0.0.1", "0.0.0.0"]);

export function resolveDemoHost(value = process.env.DEMO_HOST) {
  const host = value?.trim();
  return host && supportedDemoHosts.has(host) ? host : "127.0.0.1";
}
