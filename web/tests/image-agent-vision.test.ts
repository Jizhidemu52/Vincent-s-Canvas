import { afterEach, expect, test } from "bun:test";
import { requestToolResponse } from "../src/services/api/image";
import { defaultConfig } from "../src/stores/use-config-store";
import { IMAGE_AGENT_VISION_REQUIRED_MESSAGE } from "../../shared/image-agent-capabilities";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fixture(capabilities: unknown, onModels?: () => void) {
    const requests: string[] = [];
    globalThis.fetch = (async url => {
        requests.push(String(url));
        if (String(url) === "/api/models") {
            onModels?.();
            return Response.json({ models: [{ id: "managed", modelId: "fixture-vision-name-not-authority", name: "Visual model", capabilities, creditCost: 0, rmbCost: 0 }], tools: ["gpt-chat", "canvas-chat"].map(toolKey => ({ toolKey, modelConfigId: "managed", enabled: true })), prices: [] });
        }
        expect(String(url)).toBe("/api/chat/responses");
        return Response.json({ content: "这是当前实际图片的讨论。", toolCalls: [] });
    }) as typeof fetch;
    return requests;
}

test.each(["creative-chat", "canvas-assistant"] as const)("%s rejects a non-vision administrative binding before any chat POST", async profile => {
    for (const capabilities of [["chat"], ["chat", "Vision"], ["chat", "tools"]]) {
        const requests = fixture(capabilities);
        await expect(requestToolResponse(defaultConfig, [{ role: "user", content: "请看图改背景" }], [], "auto", undefined, { chatProfile: profile, profileContext: { stage: "plan" }, tool: profile === "canvas-assistant" ? "canvas-chat" : "gpt-chat" })).rejects.toThrow(IMAGE_AGENT_VISION_REQUIRED_MESSAGE);
        expect(requests).toEqual(["/api/models"]);
    }
});

test.each(["creative-chat", "canvas-assistant"] as const)("%s uses the existing vision binding without substitution", async profile => {
    const requests = fixture(["chat", "vision"]);
    const result = await requestToolResponse(defaultConfig, [{ role: "user", content: "先讨论，不生成" }], [], "auto", undefined, { chatProfile: profile, profileContext: { stage: "plan" }, tool: profile === "canvas-assistant" ? "canvas-chat" : "gpt-chat" });
    expect(result.content).toContain("讨论");
    expect(requests).toEqual(["/api/models", "/api/chat/responses"]);
});

test("ordinary text chat remains available on a chat-only model", async () => {
    const requests = fixture(["chat"]);
    await requestToolResponse(defaultConfig, [{ role: "user", content: "纯文字问题" }], []);
    expect(requests).toEqual(["/api/models", "/api/chat/responses"]);
});

test("an abort while resolving the model prevents the following chat POST", async () => {
    const controller = new AbortController();
    const requests = fixture(["chat", "vision"], () => controller.abort());
    await expect(requestToolResponse(defaultConfig, [{ role: "user", content: "改背景" }], [], "auto", undefined, { chatProfile: "creative-chat", profileContext: { stage: "plan" }, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toEqual(["/api/models"]);
});
