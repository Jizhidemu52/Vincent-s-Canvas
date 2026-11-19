import { describe, expect, test } from "bun:test";
import { conversationDatabaseMode, validateConversationTestDatabase } from "./helpers/conversation-postgres";
import { expectedRejection } from "./helpers/expected-rejection";

const ci = { RUN_INTEGRATION_TESTS: "true", NODE_ENV: "test", DATABASE_URL: "postgres://wireless_canvas:integration-postgres-password@127.0.0.1:5432/wireless_canvas" };
const explicit = { NODE_ENV: "test", CONVERSATION_TEST_DATABASE_URL: "postgres://fixture:local-test-only@127.0.0.1:55432/canvas_test" };

describe("conversation PostgreSQL test isolation guard", () => {
  test("rejection assertions await the operation and cannot accept a fulfilled error-shaped result", async () => {
    const marker = { code: "EXPECTED_FAILURE" };
    expect(await expectedRejection(Promise.reject(marker))).toBe(marker);
    const unexpected = await expectedRejection(Promise.resolve(marker)).then(() => null, error => error);
    expect(unexpected).toBeInstanceOf(Error);
    expect(unexpected.message).toBe("Expected the operation to reject, but it fulfilled");
  });
  test("existing isolated CI convention is enabled without an extra CI flag or PGlite fallback", () => {
    expect(conversationDatabaseMode(ci)).toBe("postgres");
    expect(conversationDatabaseMode({ ...ci, PGLITE_RUNTIME_PATH: "fixture-runtime" })).toBe("postgres");
    expect(validateConversationTestDatabase(ci)).toMatchObject({ database: "wireless_canvas", username: "wireless_canvas" });
  });
  test("explicit loopback test or ci database opt-in is supported with independent credentials", () => {
    for (const name of ["canvas_test", "test_canvas", "canvas-ci", "ci", "test"]) for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const env = { ...explicit, CONVERSATION_TEST_DATABASE_URL: `postgresql://fixture:local-test-only@${host}:55432/${name}` };
      expect(conversationDatabaseMode(env)).toBe("postgres");
      expect(validateConversationTestDatabase(env)).toMatchObject({ database: name, username: "fixture" });
    }
  });
  test("unset or disabled real integration cannot consume an ambient production DATABASE_URL", () => {
    expect(conversationDatabaseMode({ DATABASE_URL: "postgres://production.invalid/main" })).toBeNull();
    expect(conversationDatabaseMode({ RUN_INTEGRATION_TESTS: "false", PGLITE_RUNTIME_PATH: "fixture-runtime", DATABASE_URL: "postgres://production.invalid/main" })).toBe("pglite");
    expect(() => validateConversationTestDatabase({ ...ci, RUN_INTEGRATION_TESTS: "false" })).toThrow();
  });
  test("remote endpoints, query overrides, ordinary database names and non-test modes are rejected before connecting", () => {
    for (const value of ["", "postgres://fixture:sentinel-secret@remote.example/canvas_test", "postgres://fixture@127.0.0.2/canvas_test",
      "postgres://fixture@localhost/canvas", "postgres://fixture@localhost/citizens", "postgres://fixture@localhost/testimonials",
      "postgres://fixture@localhost/canvas_test?host=remote.example", "postgres://fixture@localhost/canvas_test#fragment",
      "postgres://localhost/canvas_test", "https://fixture@localhost/canvas_test", "postgres://fixture@localhost/canvas_test/other", "postgres://fixture:%E0@localhost/canvas_test"]) {
      expect(() => validateConversationTestDatabase({ ...explicit, CONVERSATION_TEST_DATABASE_URL: value })).toThrow("no database connection");
    }
    for (const NODE_ENV of [undefined, "development", "production"]) expect(() => validateConversationTestDatabase({ ...explicit, NODE_ENV })).toThrow();
  });
  test("the default DATABASE_URL path accepts only the exact existing CI identity", () => {
    for (const url of [ci.DATABASE_URL.replace("5432", "55432"), ci.DATABASE_URL.replace("wireless_canvas", "other"),
      ci.DATABASE_URL.replace("integration-postgres-password", "sentinel-secret"), ci.DATABASE_URL.replace("127.0.0.1", "localhost")]) {
      try { validateConversationTestDatabase({ ...ci, DATABASE_URL: url }); throw new Error("guard should reject"); }
      catch (error) { expect((error as Error).message).toContain("no database connection"); expect((error as Error).message).not.toContain("sentinel-secret"); }
    }
  });
  test("invalid explicit opt-in cannot silently fall back to the CI connection or PGlite", () => {
    const env = { ...ci, PGLITE_RUNTIME_PATH: "fixture-runtime", CONVERSATION_TEST_DATABASE_URL: "postgres://fixture@localhost/production" };
    expect(conversationDatabaseMode(env)).toBe("postgres");
    expect(() => validateConversationTestDatabase(env)).toThrow();
  });
});
