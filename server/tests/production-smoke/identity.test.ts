import { expect, test } from "bun:test";
import { assertSmokeProject } from "./identity";

test("staging identity is explicit and tied to the exact candidate commit", () => {
    const env = { CANVAS_SMOKE_PROJECT: "canvas-staging-aaaaaaaaaaaa-123456abcdef", CANVAS_SMOKE_COMMIT: "a".repeat(40), CANVAS_SMOKE_MODE: "staging" };
    expect(assertSmokeProject(env)).toBe(env.CANVAS_SMOKE_PROJECT);
    for (const patch of [{ CANVAS_SMOKE_MODE: "" }, { CANVAS_SMOKE_MODE: "ci" }, { CANVAS_SMOKE_COMMIT: "b".repeat(40) },
        { CANVAS_SMOKE_PROJECT: "canvas-staging-production" }, { CANVAS_SMOKE_PROJECT: "vincent-s-canvas" }, { CANVAS_SMOKE_PROJECT: "newvcan" },
        { CANVAS_SMOKE_PROJECT: "ci-release-123-1-amd64" }]) expect(() => assertSmokeProject({ ...env, ...patch })).toThrow();
    expect(assertSmokeProject({ CANVAS_SMOKE_PROJECT: "ci-release-123-1-amd64" })).toBe("ci-release-123-1-amd64");
});
