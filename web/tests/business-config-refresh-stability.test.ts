import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import type { BusinessConfig } from "@/services/api/business-config";

const config: BusinessConfig = {
    models: [{ id: "image-model", name: "图片模型", modelId: "gpt-image-2", capabilities: ["generate"], creditCost: 0, rmbCost: 0 }],
    prices: [],
    tools: [{ toolKey: "canvas-image", modelConfigId: null, enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }],
};
let savedState = useBusinessConfigStore.getState();
let savedFetch = globalThis.fetch;

function pendingResponse() {
    let complete!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { complete = resolve; });
    const calls: Array<{ input: unknown; options?: RequestInit }> = [];
    globalThis.fetch = ((input: unknown, options?: RequestInit) => {
        calls.push({ input, options });
        return response;
    }) as typeof fetch;
    return { calls, complete };
}

beforeEach(() => {
    savedState = useBusinessConfigStore.getState();
    savedFetch = globalThis.fetch;
    useBusinessConfigStore.setState(useBusinessConfigStore.getInitialState(), true);
});
afterEach(() => {
    globalThis.fetch = savedFetch;
    useBusinessConfigStore.setState(savedState, true);
});

describe("business config background refresh stability", () => {
    test("initial loading still waits for the first server configuration", async () => {
        const request = pendingResponse();
        const pending = useBusinessConfigStore.getState().refresh({ background: true });
        const during = useBusinessConfigStore.getState();
        request.complete(Response.json(config));
        await pending;
        expect(during.status).toBe("loading");
        expect(during.models).toEqual([]);
        expect(request.calls).toEqual([{ input: "/api/models", options: { credentials: "include" } }]);
        expect(useBusinessConfigStore.getState().status).toBe("ready");
        expect(useBusinessConfigStore.getState().models).toEqual(config.models);
    });

    test("background polling never makes an already available model temporarily unavailable", async () => {
        useBusinessConfigStore.setState({ ...config, status: "ready" });
        const snapshots: Array<{ status: string; modelId: string | undefined }> = [];
        const unsubscribe = useBusinessConfigStore.subscribe(state => snapshots.push({ status: state.status, modelId: state.models[0]?.id }));
        const request = pendingResponse();
        const pending = useBusinessConfigStore.getState().refresh({ background: true });
        const during = useBusinessConfigStore.getState();
        request.complete(Response.json(config));
        try { await pending; } finally { unsubscribe(); }
        expect(during.status).toBe("ready");
        expect(during.models).toBe(config.models);
        expect(snapshots.every(state => state.status === "ready" && state.modelId === "image-model")).toBe(true);
    });

    test("a completed refresh still applies removed models and disabled tools", async () => {
        useBusinessConfigStore.setState({ ...config, status: "ready" });
        const request = pendingResponse();
        const pending = useBusinessConfigStore.getState().refresh({ background: true });
        request.complete(Response.json({ models: [], prices: [], tools: [{ ...config.tools[0], enabled: false, configurationVersion: 2 }] }));
        await pending;
        const current = useBusinessConfigStore.getState();
        expect(current.status).toBe("ready");
        expect(current.models).toEqual([]);
        expect(current.tools[0]?.enabled).toBe(false);
        expect(current.tools[0]?.configurationVersion).toBe(2);
    });

    test("failed refreshes still report errors and retries do not treat old configuration as ready", async () => {
        useBusinessConfigStore.setState({ ...config, status: "ready" });
        const failed = pendingResponse();
        const pending = useBusinessConfigStore.getState().refresh({ background: true });
        failed.complete(Response.json({ message: "模型访问已失效" }, { status: 403 }));
        await expect(pending).rejects.toThrow("模型访问已失效");
        expect(useBusinessConfigStore.getState().status).toBe("error");
        expect(useBusinessConfigStore.getState().error).toBe("模型访问已失效");
        const retry = pendingResponse();
        const retried = useBusinessConfigStore.getState().refresh({ background: true });
        const during = useBusinessConfigStore.getState();
        retry.complete(Response.json(config));
        await retried;
        expect(during.status).toBe("loading");
        expect(during.error).toBeNull();
        expect(useBusinessConfigStore.getState().status).toBe("ready");
    });

    test("overlapping refreshes share one request and the next poll still runs", async () => {
        const request = pendingResponse();
        const first = useBusinessConfigStore.getState().refresh();
        const second = useBusinessConfigStore.getState().refresh();
        request.complete(Response.json(config));
        await Promise.all([first, second]);
        expect(request.calls).toHaveLength(1);
        const next = pendingResponse();
        const third = useBusinessConfigStore.getState().refresh();
        next.complete(Response.json(config));
        await third;
        expect(next.calls).toHaveLength(1);
    });

    test("explicit reloads still hide a previous identity's configuration until the response", async () => {
        useBusinessConfigStore.setState({ ...config, status: "ready" });
        const request = pendingResponse();
        const pending = useBusinessConfigStore.getState().refresh();
        const during = useBusinessConfigStore.getState();
        request.complete(Response.json({ models: [], tools: [], prices: [] }));
        await pending;
        expect(during.status).toBe("loading");
        expect(useBusinessConfigStore.getState().models).toEqual([]);
    });
});
