import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SMOKE_CHECKS, verifySmokeEvidence } from "./receipt";

function evidence() {
    const env = { CANVAS_SMOKE_PROJECT: "ci-release-123-1-amd64", CANVAS_SMOKE_COMMIT: "a".repeat(40), CANVAS_SMOKE_API_IMAGE_ID: `sha256:${"b".repeat(64)}`, CANVAS_SMOKE_WEB_IMAGE_ID: `sha256:${"c".repeat(64)}` };
    const upload = Buffer.alloc(1024 * 1024 + 1, 17);
    const original = { bytes: upload.length, sha256: createHash("sha256").update(upload).digest("hex"), width: 1024, height: 1024 };
    const identity = { schema: 1, project: env.CANVAS_SMOKE_PROJECT, paid: false };
    const browser = { ...identity, status: "passed", checks: SMOKE_CHECKS, original, taskPosts: ["image_generation", "video_generation"], chatPosts: 1, refreshStatus: "processing",
        canvasId: "c".repeat(21), imageTaskId: "12345678-abcd-abcd-abcd-123456789abc", videoTaskId: "22345678-abcd-abcd-abcd-123456789abc", uploadAssetId: "32345678-abcd-abcd-abcd-123456789abc", revision: 4 };
    const before = { ...identity, calls: [], image: original, videoBytes: 1600 };
    const after = { ...identity, image: original, videoBytes: 1600, calls: [
        { sequence: 1, kind: "image", method: "POST", path: "/v1/images/generations", model: "gpt-image-2" },
        { sequence: 2, kind: "video", method: "POST", path: "/v1/videos/generations", model: "MiniMax-H3" },
        { sequence: 3, kind: "video-poll", method: "GET", path: "/v1/tasks/smoke-video-1", model: null },
        { sequence: 4, kind: "chat", method: "POST", path: "/v1/responses", model: "gpt-6-astra" },
    ] };
    return { env, upload, browser, before, after };
}

test("formal browser receipt requires agreeing browser, provider and original-byte evidence", () => {
    const { env, upload, browser, before, after } = evidence();
    expect(verifySmokeEvidence(browser, before, after, upload, env)).toEqual({ schema: 1, status: "passed", commit: env.CANVAS_SMOKE_COMMIT,
        imageIds: { api: env.CANVAS_SMOKE_API_IMAGE_ID, web: env.CANVAS_SMOKE_WEB_IMAGE_ID }, checks: SMOKE_CHECKS });
});

test("staging creates an explicitly separate receipt and cannot impersonate CI", () => {
    const value = evidence();
    const project = `canvas-staging-${value.env.CANVAS_SMOKE_COMMIT.slice(0, 12)}-123456abcdef`;
    const env = { ...value.env, CANVAS_SMOKE_PROJECT: project, CANVAS_SMOKE_MODE: "staging" };
    const receipt = verifySmokeEvidence({ ...value.browser, project }, { ...value.before, project }, { ...value.after, project }, value.upload, env);
    expect(receipt).toMatchObject({ kind: "canvas-stage-browser-smoke", project, status: "passed" });
    expect(() => verifySmokeEvidence(value.browser, value.before, value.after, value.upload, { ...value.env, CANVAS_SMOKE_MODE: "staging" })).toThrow();
    expect(() => verifySmokeEvidence({ ...value.browser, project }, { ...value.before, project }, { ...value.after, project }, value.upload, { ...env, CANVAS_SMOKE_MODE: "ci" })).toThrow();
});

test("formal receipt rejects stale, duplicated, incomplete, paid or mismatched evidence", () => {
    const changes = [
        (value: ReturnType<typeof evidence>) => { value.after.calls.pop(); },
        (value: ReturnType<typeof evidence>) => { value.after.calls.push({ ...value.after.calls[0]!, sequence: 5 }); },
        (value: ReturnType<typeof evidence>) => { value.after.calls = value.after.calls.filter(call => call.kind !== "video-poll"); },
        (value: ReturnType<typeof evidence>) => { value.after.paid = true; },
        (value: ReturnType<typeof evidence>) => { value.after.project = "production"; },
        (value: ReturnType<typeof evidence>) => { value.browser.taskPosts.push("image_generation"); },
        (value: ReturnType<typeof evidence>) => { value.browser.chatPosts = 2; },
        (value: ReturnType<typeof evidence>) => { value.browser.refreshStatus = "success"; },
        (value: ReturnType<typeof evidence>) => { value.browser.checks = SMOKE_CHECKS.slice(0, -1); },
        (value: ReturnType<typeof evidence>) => { value.browser.original = { ...value.browser.original, sha256: "0".repeat(64) }; },
        (value: ReturnType<typeof evidence>) => { value.env.CANVAS_SMOKE_WEB_IMAGE_ID = "latest"; },
        (value: ReturnType<typeof evidence>) => { value.upload[0] = 18; },
    ];
    for (const change of changes) {
        const value = evidence(); change(value);
        expect(() => verifySmokeEvidence(value.browser, value.before, value.after, value.upload, value.env)).toThrow("Smoke evidence rejected");
    }
});
