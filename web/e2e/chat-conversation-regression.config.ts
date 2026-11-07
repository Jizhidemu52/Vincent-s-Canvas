import { defineConfig } from "@playwright/test";
import base from "./chat-agent-iteration.config";
export default defineConfig({
    ...base,
    testMatch: ["chat-agent-v518.pw.ts", "conversation-images.pw.ts"],
    grep: /chat image preview|chat keeps original|默认改图|显式方图|连续改图|生成中的|圈选保存/,
    outputDir: "../../output/chat-agent-iteration/conversational-regression",
    use: { ...base.use, viewport: { width: 1800, height: 1200 } },
});
