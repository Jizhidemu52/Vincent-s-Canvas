import { describe, expect, test } from "bun:test";
import { readProviderSubmissionDiagnostics as readDiagnostics } from "../src/provider-submission-transport";

describe("provider failure diagnostics", () => {
  test("retains separate connection attempts through a wrapped error without copying secrets", () => {
    const cause = Object.assign(new Error("private provider URL and request body"), {
      code: "ECONNRESET", phase: "initial_tls", attempts: 2,
      url: "https://private.example/?apiKey=secret", headers: { authorization: "Bearer private-key" },
      connectionAttempts: [
        { attempt: 1, phase: "initial_tls", elapsedMs: 10003.25, code: "PROVIDER_CONNECT_TIMEOUT", body: "private prompt" },
        { attempt: 2, phase: "initial_tls", elapsedMs: 82.5, code: "ECONNRESET", proxyUrl: "http://user:pass@proxy" },
      ],
    });
    const result = readDiagnostics(new Error("adapter failure", { cause }));
    expect(result).toEqual({
      code: "ECONNRESET", phase: "initial_tls", attempts: 2,
      connectionAttempts: [
        { attempt: 1, phase: "initial_tls", elapsedMs: 10003.25, code: "PROVIDER_CONNECT_TIMEOUT" },
        { attempt: 2, phase: "initial_tls", elapsedMs: 82.5, code: "ECONNRESET" },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|Bearer|user:pass/);
    expect(result!.connectionAttempts).not.toBe(cause.connectionAttempts);
  });

  test("keeps an already-submitted failure distinct from an initial connection failure", () => {
    const result = readDiagnostics(Object.assign(new Error("socket reset"), {
      code: "ECONNRESET", phase: "http_started", attempts: 1,
      connectionAttempts: [{ attempt: 1, phase: "http_started", elapsedMs: 24000, connectMs: 150.5, code: "ECONNRESET" }],
    }));
    expect(result).toEqual({
      code: "ECONNRESET", phase: "http_started", attempts: 1,
      connectionAttempts: [{ attempt: 1, phase: "http_started", elapsedMs: 24000, connectMs: 150.5, code: "ECONNRESET" }],
    });
    expect(readDiagnostics(Object.assign(new Error("stream ended"), { code: "PROVIDER_RESPONSE_STREAM_ERROR", phase: "response" })))
      .toEqual({ code: "PROVIDER_RESPONSE_STREAM_ERROR", phase: "response" });
  });

  test("does not turn ordinary or unclassified network errors into a claimed transport phase", () => {
    for (const value of [null, "failed", new Error("failed"), { code: "ECONNRESET" }, { code: "ECONNRESET", phase: "unknown" }, { code: "token=private", phase: "initial_tls" },
      { code: "ECONNRESET", phase: { toString: () => "initial_tls", credentials: "private-key" } }]) {
      expect(readDiagnostics(value)).toBeNull();
    }
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(readDiagnostics(cycle)).toBeNull();
    expect(readDiagnostics({ get code() { throw new Error("unreadable metadata"); } })).toBeNull();
  });

  test("drops malformed metadata and caps diagnostic records at the actual retry budget", () => {
    expect(readDiagnostics({
      code: "PROVIDER_CONNECT_TIMEOUT", phase: "initial_tls", attempts: 900,
      connectionAttempts: [
        { attempt: 1, phase: "initial_tls", elapsedMs: 10000, connectMs: -4, code: "https://secret.example" },
        { attempt: 2, phase: "initial_tls", elapsedMs: 10001 },
        { attempt: 3, phase: "initial_tls", elapsedMs: 10002 },
      ],
    })).toEqual({
      code: "PROVIDER_CONNECT_TIMEOUT", phase: "initial_tls",
      connectionAttempts: [
        { attempt: 1, phase: "initial_tls", elapsedMs: 10000 },
        { attempt: 2, phase: "initial_tls", elapsedMs: 10001 },
      ],
    });
    expect(readDiagnostics({ code: "ECONNRESET", phase: "initial_tls", connectionAttempts: [{ attempt: 1, phase: "initial_tls", elapsedMs: Infinity }] }))
      .toEqual({ code: "ECONNRESET", phase: "initial_tls" });
  });
});
