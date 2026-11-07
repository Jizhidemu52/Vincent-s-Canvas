import { defineConfig } from "@playwright/test";
import base from "./chat-agent-iteration.config";
export default defineConfig({
    ...base,
    testMatch: ["chat-region-composite.pw.ts", "chat-paste.pw.ts"],
    outputDir: "../../output/chat-agent-iteration/media-regression",
    use: { ...base.use, viewport: { width: 1800, height: 1200 } },
});
