import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import viteConfig from "../vite.config";

test("cleans stale hashed assets before producing a deployment build", () => {
    const config = viteConfig({ command: "build", mode: "production", isSsrBuild: false, isPreview: false });
    expect(config.build?.emptyOutDir).toBe(true);
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts.build).toContain("clean:dist");
});
