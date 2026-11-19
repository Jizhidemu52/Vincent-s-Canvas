import { defineConfig } from "@playwright/test";
import base from "./chat-agent-iteration.config";

export default defineConfig({
    ...base,
    testMatch: "chat-result-wait.pw.ts",
    outputDir: "../../output/chat-followup-20261118/browser",
    use: { ...base.use, video: "on" },
});
