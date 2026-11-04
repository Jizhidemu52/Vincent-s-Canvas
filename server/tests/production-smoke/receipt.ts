import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { assertSmokeProject } from "./identity";

export const SMOKE_CHECKS = ["login", "upload", "canvas-image", "refresh-recovery", "original-download", "video-task", "chat"];
type Evidence = Record<string, any>;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const requireEvidence = (valid: boolean, label: string): void => { if (!valid) throw new Error(`Smoke evidence rejected: ${label}`); };

/** This receipt is only emitted after browser, actual provider and original bytes agree. */
export function verifySmokeEvidence(browser: Evidence, before: Evidence, after: Evidence, upload: Uint8Array, environment: Record<string, string | undefined>) {
    const project = assertSmokeProject(environment), commit = environment.CANVAS_SMOKE_COMMIT || "";
    const imageIds = { api: environment.CANVAS_SMOKE_API_IMAGE_ID || "", web: environment.CANVAS_SMOKE_WEB_IMAGE_ID || "" };
    requireEvidence(/^[a-f0-9]{40}$/.test(commit)
        && Object.values(imageIds).every(value => /^sha256:[a-f0-9]{64}$/.test(value)), "candidate identity");
    for (const evidence of [browser, before, after]) requireEvidence(evidence.schema === 1 && evidence.project === project && evidence.paid === false, "isolated evidence identity");
    requireEvidence(browser.status === "passed" && same(browser.checks, SMOKE_CHECKS), "browser paths");
    requireEvidence(same(before.calls, []), "provider was not fresh");
    requireEvidence(Array.isArray(after.calls), "provider calls");
    const calls = after.calls as Evidence[];
    requireEvidence(calls.length >= 4 && calls.every((call, index) => call.sequence === index + 1), "provider sequence");
    const expected: Record<string, { path: string; model: string }> = {
        image: { path: "/v1/images/generations", model: "gpt-image-2" },
        video: { path: "/v1/videos/generations", model: "MiniMax-H3" },
        chat: { path: "/v1/responses", model: "gpt-6-astra" },
    };
    for (const [kind, value] of Object.entries(expected)) {
        const matching = calls.filter(call => call.kind === kind);
        requireEvidence(matching.length === 1 && matching[0]!.method === "POST" && matching[0]!.path === value.path && matching[0]!.model === value.model, `${kind} real adapter receipt`);
    }
    requireEvidence(calls.filter(call => call.kind === "video-poll").length >= 1, "real video polling");
    requireEvidence(calls.every(call => Object.hasOwn(expected, call.kind) || (call.kind === "video-poll" && call.method === "GET" && /^\/v1\/tasks\/smoke-video-\d+$/.test(call.path) && call.model === null)), "unexpected upstream request");
    requireEvidence(same(browser.taskPosts, ["image_generation", "video_generation"]) && browser.chatPosts === 1, "no duplicate browser submission");
    requireEvidence(["waiting", "processing"].includes(browser.refreshStatus), "refresh of an in-flight original task");
    const original = { bytes: upload.byteLength, sha256: createHash("sha256").update(upload).digest("hex"), width: 1024, height: 1024 };
    requireEvidence(original.bytes > 1024 * 1024 && same(browser.original, original) && same(after.image, original) && same(before.image, original), "unchanged original image bytes and dimensions");
    requireEvidence(Number.isInteger(after.videoBytes) && after.videoBytes >= 1000, "real video fixture");
    requireEvidence(/^[A-Za-z0-9_-]{21}$/.test(browser.canvasId || ""), "durable canvasId");
    for (const field of ["imageTaskId", "videoTaskId", "uploadAssetId"]) requireEvidence(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(browser[field] || ""), `durable ${field}`);
    requireEvidence(Number.isInteger(browser.revision) && browser.revision > 0, "saved canvas revision");
    return { schema: 1, ...(environment.CANVAS_SMOKE_MODE === "staging" ? { kind: "canvas-stage-browser-smoke", project } : {}), status: "passed", commit, imageIds, checks: SMOKE_CHECKS };
}

if (import.meta.main) {
    const output = process.env.CANVAS_SMOKE_OUTPUT_DIR || "";
    requireEvidence(isAbsolute(output), "explicit output directory");
    const json = async (name: string) => JSON.parse(await readFile(resolve(output, name), "utf8")) as Evidence;
    const receipt = verifySmokeEvidence(await json("browser-checks.private.json"), await json("provider-before.private.json"), await json("provider-after.private.json"), await readFile(resolve(output, "upload.png")), process.env);
    const filename = process.env.CANVAS_SMOKE_MODE === "staging" ? "staging-browser-smoke.json" : "browser-smoke.json";
    await writeFile(resolve(output, filename), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
