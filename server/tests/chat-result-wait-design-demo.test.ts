import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { designDiscussionRequest as designInput } from "./fixtures/design-discussion-request";

const designContent = JSON.stringify({ message: "保留六颗纽扣与两个口袋，仅讨论配色。", questions: [], proposals: [], sources: [], trendStatus: "未实时检索" });

for (const model of ["gpt-6.2-sol", "gemini-4-carbon"]) test(`demo ${model} design waiting preserves the no-profile contract and rejects injected private deadlines`, async () => {
    const pending = Promise.withResolvers<void>();
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.headers.get("authorization") !== "Bearer isolated-design-wait-key") return new Response(null, { status: 404 });
        const body = await request.json() as Record<string, unknown>;
        calls.push({ path, body });
        if (calls.length === 1) await pending.promise;
        if (calls.length === 2) return new Response("isolated-design-wait-key private upstream echo", { status: 524 });
        return body.model === "gpt-6.2-sol"
            ? Response.json({ id: "resp-design", object: "response", status: "completed", output: [
                { id: "msg-design", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: designContent }] },
            ] })
            : Response.json({ choices: [{ message: { content: designContent }, finish_reason: "stop" }] });
    } });
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port; reservation.stop(true);
    const policyUrl = new URL("../src/chat-model-policy.ts", import.meta.url);
    const bootstrap = `import { mock } from "bun:test";
      const policy = await import(${JSON.stringify(policyUrl.href)});
      mock.module(${JSON.stringify(fileURLToPath(policyUrl))}, () => ({ ...policy, INITIAL_CHAT_MODEL_ID: ${JSON.stringify(model)}, INITIAL_CANVAS_DESIGN_CHAT_MODEL_ID: ${JSON.stringify(model)} }));
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = milliseconds => { if (milliseconds === 180000 || milliseconds === 600000) console.log("TEST_CHAT_BUDGET=" + milliseconds); return timeout(milliseconds); };
      await import(${JSON.stringify(new URL("../src/demo-server.ts", import.meta.url).href)});`;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", bootstrap], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
        env: { ...process.env, DEMO_STATE_PATH: ":memory:", DEMO_RECOVERY_FILE: "", DEMO_PORT: String(port), DEMO_HOST: "127.0.0.1",
            OA_LOGIN_ENABLED: "false", AUTH_ENABLED: "true", CREDITS_ENABLED: "false", LOCAL_STANDALONE: "true", ROLE_PORTALS_ENABLED: "false", STANDALONE_WEB_DIR: "", DEMO_PUBLIC_ASSET_ORIGIN: "",
            OPENTOKEN_API_KEY: "", APIMART_API_KEY: "", GPT_IMAGE_2_API_KEY: "", MARK_IMAGE_API_KEY: "isolated-design-wait-key",
            OPENTOKEN_BASE_URL: `http://127.0.0.1:${provider.port}/disabled/v1`, APIMART_BASE_URL: `http://127.0.0.1:${provider.port}/disabled/v1`, MARK_IMAGE_BASE_URL: `http://127.0.0.1:${provider.port}/mark/v1` },
    });
    const base = `http://127.0.0.1:${port}`;
    const post = (accept = "text/event-stream", extra = {}) => fetch(`${base}/api/chat/responses`, {
        method: "POST", headers: { "content-type": "application/json", accept, "x-request-id": "demo-design-correlation" }, body: JSON.stringify({ ...designInput, ...extra }), signal: AbortSignal.timeout(5000),
    });
    try {
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            if (await fetch(`${base}/api/health`).then(response => response.ok).catch(() => false)) { ready = true; break; }
            if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
            await Bun.sleep(50);
        }
        expect(ready).toBe(true);
        const fallback = setTimeout(() => pending.resolve(), 500);
        let response: Response;
        try { response = await post("text/event-stream", { privateProfile: true, waitForResult: true, resultTimeoutMs: 600_000 }); }
        finally { clearTimeout(fallback); }
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expect(response.headers.get("x-accel-buffering")).toBe("no");
        const reader = response.body!.getReader(), decoder = new TextDecoder();
        const initial = decoder.decode((await reader.read()).value);
        expect(initial).toContain("event: chat_waiting");
        expect(initial).not.toContain("event: chat_result");
        pending.resolve();
        let wire = initial;
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) wire += decoder.decode(chunk.value);
        expect(wire.match(/event: chat_result/g)).toHaveLength(1);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.path).toBe(model === "gpt-6.2-sol" ? "/mark/v1/responses" : "/mark/v1/chat/completions");
        expect(calls[0]!.body).toMatchObject({ model, stream: false });
        expect(calls[0]!.body).not.toHaveProperty("privateProfile");
        expect(calls[0]!.body).not.toHaveProperty("waitForResult");
        if (model === "gpt-6.2-sol") expect(calls[0]!.body).toMatchObject({ tools: [], tool_choice: "none", input: designInput.input });
        else expect(calls[0]!.body).not.toHaveProperty("tools");
        const failed = await post(), failedWire = await failed.text();
        expect(failed.headers.get("content-type")).toContain("text/event-stream");
        expect(failedWire).toContain("UPSTREAM_REQUEST_FAILED");
        expect(failedWire).toContain("524");
        expect(failedWire).not.toContain("chat_result");
        expect(failedWire).not.toContain("isolated-design-wait-key");
        expect(failedWire).not.toContain("private upstream echo");
        const json = await post("application/json", { privateProfile: true, waitForResult: true, resultTimeoutMs: 600_000 });
        expect(json.headers.get("content-type")).toContain("application/json");
        expect((await json.json()).content).toBe(designContent);
        const ordinary = await post("text/event-stream", { toolKey: "gpt-chat", privateProfile: true, waitForResult: true, resultTimeoutMs: 600_000 });
        expect(ordinary.headers.get("content-type")).toContain("application/json");
        expect((await ordinary.json()).content).toBe(designContent);
        expect(calls).toHaveLength(4);
    } finally {
        pending.resolve(); child.kill(); await child.exited; provider.stop(true);
    }
    const errors = await new Response(child.stderr).text(), output = await new Response(child.stdout).text();
    expect(errors.match(/Chat request failed/g)).toHaveLength(1);
    expect(errors).toContain("upstreamStatus: 524");
    expect(errors).toContain('correlationId: "demo-design-correlation"');
    expect(errors).toContain('toolKey: "canvas-design-chat"');
    expect(errors).toContain("modelConfigId:");
    expect(errors).toContain("configurationVersion: 0");
    for (const secret of ["isolated-design-wait-key", "private upstream echo", designInput.input.at(-1)!.content]) expect(errors).not.toContain(secret);
    expect(output.match(/TEST_CHAT_BUDGET=180000/g)).toHaveLength(4);
    expect(output).not.toContain("TEST_CHAT_BUDGET=600000");
}, 15_000);

test("demo no-profile Claude design discussion preserves native streaming without private filtering or waiting", async () => {
    const events = 'event: message_start\ndata: {"type":"message_start","message":{"id":"native-design-message","role":"assistant","content":[]}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"native-thinking-fixture"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        calls.push({ path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown> });
        return new Response(events, { headers: { "content-type": "text/event-stream" } });
    } });
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port; reservation.stop(true);
    const policyUrl = new URL("../src/chat-model-policy.ts", import.meta.url);
    const bootstrap = `import { mock } from "bun:test";
      const policy = await import(${JSON.stringify(policyUrl.href)});
      mock.module(${JSON.stringify(fileURLToPath(policyUrl))}, () => ({ ...policy, INITIAL_CHAT_MODEL_ID: "claude-sonnet-5-5", INITIAL_CANVAS_DESIGN_CHAT_MODEL_ID: "claude-sonnet-5-5" }));
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = milliseconds => { if (milliseconds === 180000 || milliseconds === 600000) console.log("TEST_CHAT_BUDGET=" + milliseconds); return timeout(milliseconds); };
      await import(${JSON.stringify(new URL("../src/demo-server.ts", import.meta.url).href)});`;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", bootstrap], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
        env: { ...process.env, DEMO_STATE_PATH: ":memory:", DEMO_RECOVERY_FILE: "", DEMO_PORT: String(port), DEMO_HOST: "127.0.0.1",
            OA_LOGIN_ENABLED: "false", AUTH_ENABLED: "true", CREDITS_ENABLED: "false", LOCAL_STANDALONE: "true", ROLE_PORTALS_ENABLED: "false", STANDALONE_WEB_DIR: "", DEMO_PUBLIC_ASSET_ORIGIN: "",
            OPENTOKEN_API_KEY: "", APIMART_API_KEY: "", GPT_IMAGE_2_API_KEY: "", MARK_IMAGE_API_KEY: "isolated-design-stream-key",
            OPENTOKEN_BASE_URL: `http://127.0.0.1:${provider.port}/disabled/v1`, APIMART_BASE_URL: `http://127.0.0.1:${provider.port}/disabled/v1`, MARK_IMAGE_BASE_URL: `http://127.0.0.1:${provider.port}/mark/v1` },
    });
    const base = `http://127.0.0.1:${port}`;
    try {
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            if (await fetch(`${base}/api/health`).then(response => response.ok).catch(() => false)) { ready = true; break; }
            if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
            await Bun.sleep(50);
        }
        expect(ready).toBe(true);
        const response = await fetch(`${base}/api/chat/responses`, {
            method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" },
            body: JSON.stringify({ ...designInput, claude: { stream: true, thinking: true }, privateProfile: true, waitForResult: true }), signal: AbortSignal.timeout(5000),
        });
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expect(await response.text()).toBe(events);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.path).toBe("/mark/v1/messages");
        expect(calls[0]!.body).toMatchObject({ model: "claude-sonnet-5-5", stream: true });
        expect(calls[0]!.body).not.toHaveProperty("privateProfile");
    } finally {
        child.kill(); await child.exited; provider.stop(true);
    }
    const errors = await new Response(child.stderr).text(), output = await new Response(child.stdout).text();
    expect(errors).not.toContain("Chat request failed");
    expect(output.match(/TEST_CHAT_BUDGET=180000/g)).toHaveLength(1);
    expect(output).not.toContain("TEST_CHAT_BUDGET=600000");
}, 15_000);
