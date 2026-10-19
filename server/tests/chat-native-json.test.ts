import { describe, expect, test } from "bun:test";

import { requestChatCompletion } from "../src/routes/chat";

const protocols = ["anthropic", "apimart", "gemini"] as const;
type NativeProtocol = typeof protocols[number];

function responseBody(protocol: NativeProtocol, argumentsJson: string) {
  return protocol === "gemini"
    ? `{"candidates":[{"content":{"parts":[{"functionCall":{"name":"create_image","args":${argumentsJson}}}]}}]}`
    : `{"content":[{"type":"tool_use","id":"create-1","name":"create_image","input":${argumentsJson}}],"stop_reason":"tool_use"}`;
}

async function withProviderResponse(protocol: NativeProtocol, body: string, check: (pending: ReturnType<typeof requestChatCompletion>) => Promise<void>) {
  let requests = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch() {
      requests++;
      return new Response(body, { headers: { "content-type": "application/json" } });
    },
  });
  try {
    await check(requestChatCompletion(
      { model_id: protocol === "gemini" ? "gemini-test" : "claude-sonnet-5-5", protocol, base_url: `http://127.0.0.1:${provider.port}/v1`, encrypted_credentials: null },
      { apiKey: "local-json-fixture" },
      { input: [{ role: "user", content: "保留领口和白底，衣身改蓝色" }], tools: [{ type: "function", name: "create_image", parameters: { type: "object" } }] },
    ));
    expect(requests).toBe(1);
  } finally {
    provider.stop(true);
  }
}

for (const protocol of protocols) {
  describe(`${protocol} raw native tool JSON`, () => {
    test.each([
      '"preserve":["领口不变"],"preserve":["白底不变"]',
      '"preserve":"七颗纽扣不变","preserve":"白底不变"',
      String.raw`"preserve":["领口不变"],"pre\u0073erve":["白底不变"]`,
      '"preserve":[],"reference_roles":[{"image_id":"shirt","image_id":"other"}]',
    ])("rejects duplicate keys before native object parsing loses an earlier value: %s", async (fields) => {
      const body = responseBody(protocol, `{"action":"generate","prompt":"衣身改蓝色",${fields}}`);
      await withProviderResponse(protocol, body, async (pending) => {
        await expect(pending).rejects.toMatchObject({ code: "CHAT_RESPONSE_DUPLICATE_KEYS" });
      });
    });

    test.each([
      { preserve: "领口不变；七颗纽扣不变" },
      { preserve: '["领口不变","白底不变"]' },
      { preserve: ["领口不变", "白底不变"] },
    ])("keeps valid constraint data unchanged for downstream normalization: %j", async ({ preserve }) => {
      const args = { action: "generate", prompt: '字面文字："preserve":"a","preserve":"b"；中文 🧶', preserve };
      await withProviderResponse(protocol, responseBody(protocol, JSON.stringify(args)), async (pending) => {
        const result = await pending;
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]?.function.name).toBe("create_image");
        expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual(args);
      });
    });

    test.each(["null", "[]", '{"content":', '{"preserve":[],}', '{"same":1 // comment\n}'])("rejects malformed native JSON without a retry: %s", async (body) => {
      await withProviderResponse(protocol, body, async (pending) => {
        await expect(pending).rejects.toMatchObject({ code: "CHAT_RESPONSE_INVALID_JSON" });
      });
    });

    test("separate object scopes do not create false duplicate-key errors", async () => {
      const args = { preserve: ["领口不变"], roles: [{ image_id: "shirt" }, { image_id: "palette" }] };
      await withProviderResponse(protocol, responseBody(protocol, JSON.stringify(args)), async (pending) => {
        const result = await pending;
        expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual(args);
      });
    });
  });
}
