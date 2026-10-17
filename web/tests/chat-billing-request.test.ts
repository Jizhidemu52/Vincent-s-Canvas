import { afterEach, expect, test } from "bun:test";
import { requestToolResponse } from "../src/services/api/image";
import { defaultConfig } from "../src/stores/use-config-store";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("each model call has its own billing ID; explicit transport replay retains that ID", async () => {
    const ids: string[] = [];
    globalThis.fetch = (async (url, init) => {
        if (String(url) === "/api/models") return Response.json({ models: [{ id: "fixture-chat", modelId: "fixture-chat", name: "fixture", capabilities: ["chat"], creditCost: 7, rmbCost: 0 }], tools: [{ toolKey: "gpt-chat", modelConfigId: "fixture-chat", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }], prices: [] });
        expect(String(url)).toBe("/api/chat/responses");
        ids.push(JSON.parse(String(init?.body)).requestId);
        return Response.json({ content: "fixture answer", toolCalls: [] });
    }) as typeof fetch;
    const call = (chatRequestId?: string) => requestToolResponse({ ...defaultConfig, model: "fixture-chat", textModel: "fixture-chat" }, [{ role: "user", content: "fixture" }], [], "auto", undefined, { requestId: "image-task-unrelated", chatRequestId });
    await call(); await call(); await call("client-lan-retry-123"); await call("client-lan-retry-123");
    expect(ids[0]).toMatch(/^[a-zA-Z0-9:_-]{8,160}$/);
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids).not.toContain("image-task-unrelated");
    expect(ids.slice(2)).toEqual(["client-lan-retry-123", "client-lan-retry-123"]);
});

test("a chat stopped during model resolution has no submission marker or POST", async () => {
    const controller = new AbortController();
    const paths: string[] = [], started: string[] = [];
    globalThis.fetch = (async url => {
        paths.push(String(url));
        controller.abort();
        return Response.json({ models: [{ id: "fixture-chat", modelId: "fixture-chat", name: "fixture", capabilities: ["chat"], creditCost: 7, rmbCost: 0 }], tools: [{ toolKey: "gpt-chat", modelConfigId: "fixture-chat", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }], prices: [] });
    }) as typeof fetch;
    await expect(requestToolResponse({ ...defaultConfig, model: "fixture-chat" }, [{ role: "user", content: "fixture" }], [], "auto", undefined,
        { signal: controller.signal, onChatSubmissionStarted: id => started.push(id) })).rejects.toMatchObject({ name: "AbortError" });
    expect(paths).toEqual(["/api/models"]);
    expect(started).toEqual([]);
});

test("the chat submission marker records the exact request ID before POST, including a lost response", async () => {
    const started: string[] = [], posted: string[] = [];
    globalThis.fetch = (async (url, init) => {
        if (String(url) === "/api/models") return Response.json({ models: [{ id: "fixture-chat", modelId: "fixture-chat", name: "fixture", capabilities: ["chat"], creditCost: 7, rmbCost: 0 }], tools: [{ toolKey: "gpt-chat", modelConfigId: "fixture-chat", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }], prices: [] });
        const id = JSON.parse(String(init?.body)).requestId;
        expect(started).toEqual([id]);
        posted.push(id);
        throw new DOMException("connection interrupted", "AbortError");
    }) as typeof fetch;
    await expect(requestToolResponse({ ...defaultConfig, model: "fixture-chat" }, [{ role: "user", content: "fixture" }], [], "auto", undefined,
        { onChatSubmissionStarted: id => started.push(id) })).rejects.toMatchObject({ name: "AbortError" });
    expect(posted).toEqual(started);
    expect(posted).toHaveLength(1);
});
