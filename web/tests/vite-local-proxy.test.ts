import { expect, test } from "bun:test";

import viteConfig from "../vite.config";

test("uses the IPv4 loopback address for the local API proxy by default", () => {
    const config = viteConfig({ command: "serve", mode: "development", isSsrBuild: false, isPreview: false });

    expect(config.server?.proxy?.["/api"]).toMatchObject({ target: "http://127.0.0.1:3100" });
});
