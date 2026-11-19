import { expect, test } from "bun:test";
import { loadConfig, type AppConfig } from "../src/config";

const base = { DATABASE_URL: "postgres://test", REDIS_URL: "redis://test" };

test("conversation output limits are optional server-only administrative settings", () => {
    expect(loadConfig(base).IMAGE_CONVERSATION_OUTPUT_LIMITS).toBeUndefined();
    expect(loadConfig({ ...base, IMAGE_CONVERSATION_OUTPUT_LIMITS: "" }).IMAGE_CONVERSATION_OUTPUT_LIMITS).toEqual({});
    const limits = { allowedQualities: ["high", "xhigh"], allowedResolutions: ["2k", "4k"], maxInternalCredits: 20 } satisfies AppConfig["IMAGE_CONVERSATION_OUTPUT_LIMITS"];
    expect(loadConfig({ ...base, IMAGE_CONVERSATION_OUTPUT_LIMITS: JSON.stringify(limits) }).IMAGE_CONVERSATION_OUTPUT_LIMITS).toEqual(limits);
});

test.each(["invalid-json", "null", "[]", '{"allowedQualities":[]}', '{"allowedResolutions":["auto"]}', '{"allowedQualities":["auto"]}', '{"maxInternalCredits":-1}', '{"maxInternalCredits":1.5}', '{"providerBudget":5}'])("invalid conversation policy cannot silently start unrestricted: %s", value => {
    expect(() => loadConfig({ ...base, IMAGE_CONVERSATION_OUTPUT_LIMITS: value })).toThrow();
});
