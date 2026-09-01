import { expect, test } from "bun:test";

import { resolveDemoHost } from "../src/demo-network-config";

test("keeps the demo server on loopback unless LAN hosting is explicitly requested", () => {
  expect(resolveDemoHost()).toBe("127.0.0.1");
  expect(resolveDemoHost("0.0.0.0")).toBe("0.0.0.0");
  expect(resolveDemoHost("192.168.1.20")).toBe("127.0.0.1");
});
