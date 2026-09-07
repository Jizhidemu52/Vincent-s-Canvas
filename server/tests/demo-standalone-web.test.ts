import { expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { resolveStandaloneStaticPath } from "../src/demo-standalone-web";

test("serves standalone files from the build directory without allowing path traversal", () => {
  const root = resolve("portable", "web");
  expect(resolveStandaloneStaticPath(root, "/")).toBe(join(root, "index.html"));
  expect(resolveStandaloneStaticPath(root, "/assets/app.js")).toBe(join(root, "assets", "app.js"));
  expect(resolveStandaloneStaticPath(root, "/../.env")).toBeNull();
});
