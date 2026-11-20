import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { CANVAS_ASSISTANT_SYSTEM_PROMPT } from "../src/prompt-chat-profiles";

test("demo private Carbon negotiates waiting before the original response, validates output and never retries", async () => {
    const pending = Promise.withResolvers<void>();
    const calls: Array<Record<string, unknown>> = [];
    const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        if (new URL(request.url).pathname !== "/mark/v1/chat/completions" || request.headers.get("authorization") !== "Bearer isolated-wait-key") return new Response(null, { status: 404 });
        calls.push(await request.json());
        const index = calls.length;
        if (index === 1) await pending.promise;
        if (index === 3) return Response.json({ error: { message: "isolated-wait-key private provider echo" } }, { status: 503 });
        return Response.json({ choices: [{ message: { content: index === 4 ? CANVAS_ASSISTANT_SYSTEM_PROMPT : "继续保留领口，调整为蓝色。" }, finish_reason: "stop" }], usage: { prompt_tokens: 90, completion_tokens: 10 } });
    } });
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port; reservation.stop(true);
    const policyUrl = new URL("../src/chat-model-policy.ts", import.meta.url);
    const serverUrl = new URL("../src/demo-server.ts", import.meta.url);
    const bootstrap = `import { mock } from "bun:test";
      const policy = await import(${JSON.stringify(policyUrl.href)});
      mock.module(${JSON.stringify(fileURLToPath(policyUrl))}, () => ({ ...policy, INITIAL_CHAT_MODEL_ID: "gemini-4-carbon" }));
      await import(${JSON.stringify(serverUrl.href)});`;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", bootstrap], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "ignore", stderr: "pipe",
        env: { ...process.env, DEMO_STATE_PATH: ":memory:", DEMO_RECOVERY_FILE: "", DEMO_PORT: String(port), DEMO_HOST: "127.0.0.1",
            OA_LOGIN_ENABLED: "false", AUTH_ENABLED: "true", CREDITS_ENABLED: "false", LOCAL_STANDALONE: "true", ROLE_PORTALS_ENABLED: "false", STANDALONE_WEB_DIR: "", DEMO_PUBLIC_ASSET_ORIGIN: "",
            OPENTOKEN_API_KEY: "", APIMART_API_KEY: "", GPT_IMAGE_2_API_KEY: "", MARK_IMAGE_API_KEY: "isolated-wait-key",
            OPENTOKEN_BASE_URL: `http://127.0.0.1:${provider.port}/disabled/v1`, APIMART_BASE_URL: `http://127.0.0.1:${provider.port}/disabled/v1`, MARK_IMAGE_BASE_URL: `http://127.0.0.1:${provider.port}/mark/v1` },
    });
    const base = `http://127.0.0.1:${port}`;
    const prompt = "继续把衬衫改成蓝色";
    const body = { toolKey: "canvas-chat", profile: "canvas-assistant", input: [{ role: "user", content: prompt }], tools: [],
        profileContext: { stage: "plan", currentUserText: prompt, imageCatalog: [], previewImageIds: [], newCreation: false, workNote: "" } };
    const post = (accept = "text/event-stream", extra = {}) => fetch(`${base}/api/chat/responses`, {
        method: "POST", headers: { "content-type": "application/json", accept }, body: JSON.stringify({ ...body, ...extra }), signal: AbortSignal.timeout(5000),
    });
    try {
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            if (await fetch(`${base}/api/health`).then(response => response.ok).catch(() => false)) { ready = true; break; }
            if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
            await Bun.sleep(50);
        }
        expect(ready).toBe(true);
        const response = await post();
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expect(response.headers.get("x-accel-buffering")).toBe("no");
        const reader = response.body!.getReader(), decoder = new TextDecoder();
        const initial = decoder.decode((await reader.read()).value);
        expect(initial).toContain("event: chat_waiting");
        expect(initial).not.toContain("event: chat_result");
        pending.resolve();
        let wire = initial;
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) wire += decoder.decode(chunk.value);
        expect(wire).toContain("event: chat_result");
        expect(wire).toContain("继续保留领口");
        expect(wire).not.toContain("usage");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ model: "gemini-4-carbon", stream: false });
        expect(calls[0]).not.toHaveProperty("waitForResult");
        const json = await post("application/json", { waitForResult: true, resultTimeoutMs: 999_999_999 });
        expect(json.headers.get("content-type")).toContain("application/json");
        expect((await json.json()).content).toContain("继续保留领口");
        for (const code of ["UPSTREAM_REQUEST_FAILED", "PROMPT_OUTPUT_REJECTED"]) {
            const failed = await post(), text = await failed.text();
            expect(failed.headers.get("content-type")).toContain("text/event-stream");
            expect(text).toContain(`"code":"${code}"`);
            expect(text).not.toContain("event: chat_result");
            expect(text).not.toContain("isolated-wait-key");
            expect(text).not.toContain(CANVAS_ASSISTANT_SYSTEM_PROMPT);
        }
        expect(calls).toHaveLength(4);
    } finally {
        pending.resolve(); child.kill(); await child.exited; provider.stop(true);
    }
    const errors = await new Response(child.stderr).text();
    expect(errors.match(/Chat request failed/g)).toHaveLength(2);
    expect(errors).toContain("UPSTREAM_REQUEST_FAILED");
    expect(errors).toContain("upstreamStatus: 503");
    expect(errors).toContain("PROMPT_OUTPUT_REJECTED");
    expect(errors).toContain("elapsedMs:");
    expect(errors).not.toContain("isolated-wait-key");
    expect(errors).not.toContain("private provider echo");
    expect(errors).not.toContain(prompt);
    expect(errors).not.toContain(CANVAS_ASSISTANT_SYSTEM_PROMPT);
}, 15_000);
