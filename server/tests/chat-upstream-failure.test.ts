import { describe, expect, test } from "bun:test";
import { chatUpstreamFailureMessage, readChatUpstreamFailure } from "../src/chat-upstream-failure";

const secret = "Bearer private-key https://user:password@private.invalid private-user-prompt";

describe("safe upstream chat failure categories", () => {
    for (const [status, reason] of [[401, "authentication_failed"], [403, "access_denied"], [402, "balance_insufficient"], [413, "request_too_large"], [429, "rate_limited"], [500, "service_unavailable"], [503, "service_unavailable"]] as const) {
        test(`${status} is classified from status without exposing or reading the body`, async () => {
            let pulls = 0, cancelled = false;
            const body = new ReadableStream({ pull() { pulls++; throw new Error(secret); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
            const actual = await readChatUpstreamFailure(new Response(body, { status }));
            expect(actual).toBe(reason); expect(pulls).toBe(0); expect(cancelled).toBe(true);
            const message = chatUpstreamFailureMessage("Claude Provider", status, actual);
            expect(message).toContain(String(status)); expect(message).toContain("不会自动重新提交"); expect(message).not.toContain(secret);
        });
    }

    for (const [message, reason] of [
        ["operation error Bedrock Runtime: InvokeModel, https response error StatusCode: 400, ValidationException: Access to Bedrock models is not allowed for this account.", "access_denied"],
        ["invalid thinking signature", "thinking_history_invalid"],
        ["tool_result must follow matching tool_use_id", "tool_sequence_invalid"],
        ["tool_choice is not supported", "tool_choice_unsupported"],
        ["image exceeds size limit", "image_input_invalid"],
        ["context length exceeded", "context_too_large"],
        ["unknown parameter output_config", "parameter_unsupported"],
        ["insufficient balance", "balance_insufficient"],
        ["organization spend limit reached", "balance_insufficient"],
        ["model not found", "model_unavailable"],
        ["unrecognized failure", "request_invalid"],
    ] as const) test(`bounded structured provider detail maps only to ${reason}`, async () => {
        const actual = await readChatUpstreamFailure(Response.json({ error: { type: "invalid_request_error", message: `${message}: ${secret}`, request: { authorization: secret } } }, { status: 400 }));
        expect(actual).toBe(reason);
        expect(chatUpstreamFailureMessage("Claude Provider", 400, actual)).not.toContain(secret);
    });

    test("additional echoed request properties cannot classify an error", async () => {
        expect(await readChatUpstreamFailure(Response.json({ error: { message: "unknown", request: "tool_choice invalid" }, request: { model: "model not found" } }, { status: 400 }))).toBe("request_invalid");
    });
    test.each(["<html>invalid thinking signature</html>", "not JSON", JSON.stringify({ error: { message: `invalid thinking signature${"x".repeat(70_000)}` } })])("invalid or oversized body remains status-only", async body => {
        expect(await readChatUpstreamFailure(new Response(body, { status: 400 }))).toBe("request_invalid");
    });
    test("HTTP status is not replaced by an error-body transport failure", async () => {
        const body = new ReadableStream({ pull(controller) { controller.error(new Error(secret)); } });
        expect(await readChatUpstreamFailure(new Response(body, { status: 422 }))).toBe("request_invalid");
    });
    test("HTML 404 does not invent a missing-model cause", async () => {
        expect(await readChatUpstreamFailure(new Response("<html>model not found</html>", { status: 404 }))).toBe("unclassified");
    });
    test("temporary server errors are not described as invalid user input", () => {
        const message = chatUpstreamFailureMessage("Claude Provider", 503, "service_unavailable");
        expect(message).toContain("不代表图片或提示词有误"); expect(message).not.toContain("请求参数");
    });
    test("Bedrock HTTP 400 account denial does not advise changing the image or prompt", async () => {
        const reason = await readChatUpstreamFailure(Response.json({ error: { type: "invalid_request_error", message: "Access to Bedrock models is not allowed for this account." } }, { status: 400 }));
        const message = chatUpstreamFailureMessage("Claude Provider", 400, reason);
        expect(reason).toBe("access_denied");
        expect(message).toContain("访问权限");
        expect(message).not.toContain("请求参数");
        expect(message).not.toContain("参考图");
    });
});
