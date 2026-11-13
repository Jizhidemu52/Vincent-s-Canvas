import { createHash } from "node:crypto";
import type { Page, Route } from "@playwright/test";
import { test, expect, fixturePng, type MockCanvasApi } from "./fixtures";

const OWNER = "00000000-0000-4000-8000-000000000099";
const MODEL = "10000000-0000-4000-8000-000000000001";
const PROJECT = "sequence-handoff";
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");

async function openWorkflow(page: Page, api: MockCanvasApi) {
    const now = new Date().toISOString(), source = "source-root", ids = ["step-one", "step-two", "step-three"];
    const sourceUrl = `/api/assets/${source}/content`;
    api.assets.set(source, { id: source, ownerUserId: OWNER, status: "ready", kind: "image", mimeType: "image/png", contentUrl: sourceUrl });
    api.assetBytes.set(source, fixturePng(15));
    const nodes = [{ id: source, type: "image", title: "Original", position: { x: 20, y: 130 }, width: 160, height: 160, metadata: { content: sourceUrl, status: "success", naturalWidth: 256, naturalHeight: 256 } }, ...ids.map((id, index) => ({
        id, type: "config", title: `Step ${index + 1}`, position: { x: 240 + index * 420, y: 130 }, width: 360, height: 440,
        metadata: { model: MODEL, generationMode: "image", generationType: "edit", configImageInputMode: "combined", count: 1, size: "1:1", quality: "low", status: "idle",
            prompt: `HANDOFF_STEP_${index + 1} Change only the background.`, composerContent: `HANDOFF_STEP_${index + 1} Change only the background.` },
    }))];
    const connections = [{ id: "original-input", fromNodeId: source, toNodeId: ids[0] }, ...ids.slice(1).map((id, index) => ({ id: `sequence-${index}`, fromNodeId: ids[index], toNodeId: id, kind: "config-sequence" }))];
    const group = { id: "handoff-group", title: "Handoff fixture", collapsed: false, nodeIds: ids,
        imageSequence: { sourceNodeId: source, status: "idle", steps: ids.map((configNodeId, index) => ({ configNodeId, ...(index ? { inputConfigId: ids[index - 1] } : {}), status: "idle" })) } };
    const document = { id: PROJECT, title: "Handoff fixture", createdAt: now, updatedAt: now, nodes, connections, groups: [group], viewport: { x: 40, y: 70, k: 0.8 }, backgroundMode: "dots", chatSessions: [], activeChatId: null };
    api.documents.set(PROJECT, { id: PROJECT, revision: 1, deleted: false, document, updatedAt: now });
    await page.goto(`/canvas/${PROJECT}`);
    await expect(page.getByRole("button", { name: "上传素材", exact: true })).toBeVisible();
    const first = page.locator(`[data-node-id="${ids[0]}"]`);
    await expect(first.getByRole("button", { name: "运行工作流", exact: true })).toBeEnabled();
    return { ids, first };
}

test("successful upstream output waits for its bytes, then automatically POSTs the next exact input", async ({ page, api }, info) => {
    api.taskStatus = "processing";
    const heldDownloads: Route[] = [];
    let holdFirstOutput = true, firstTaskId = "";
    await page.route(/\/api\/assets\/[^/]+\/content$/, route => {
        const id = new URL(route.request().url()).pathname.split("/")[3]!;
        if (id === firstTaskId && holdFirstOutput) { heldDownloads.push(route); return; }
        return route.fallback();
    });
    const { ids, first } = await openWorkflow(page, api);
    await first.getByRole("button", { name: "运行工作流", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    const firstTask = [...api.tasks.values()][0]!;
    firstTaskId = firstTask.id;
    // The original task binding is already persisted while the provider remains pending.
    await expect.poll(() => api.document(PROJECT)?.nodes.some((node: any) => node.metadata?.imageTask?.taskId === firstTaskId)).toBe(true);
    expect(api.submissions[0]!.prompt).toContain("HANDOFF_STEP_1");
    firstTask.status = "success";
    firstTask.resultUrls = [`/api/assets/${firstTaskId}/content`];
    await expect.poll(() => heldDownloads.length).toBeGreaterThan(0);
    expect(api.submissions).toHaveLength(1);
    expect(api.document(PROJECT)!.groups[0].imageSequence.steps[1].status).toBe("idle");
    holdFirstOutput = false;
    for (const route of heldDownloads.splice(0)) await route.fulfill({ contentType: "image/png", body: api.assetBytes.get(firstTaskId)! });
    await expect.poll(() => api.submissions.length).toBe(2);
    expect(api.submissions[1]!.prompt).toContain("HANDOFF_STEP_2");
    const secondInputId = api.submissions[1]!.sourceUrls[0].split("/")[3];
    expect(sha(api.assetBytes.get(secondInputId)!)).toBe(sha(api.assetBytes.get(firstTaskId)!));
    for (let index = 1; index < 3; index++) {
        const task = [...api.tasks.values()][index]!;
        task.status = "success"; task.resultUrls = [`/api/assets/${task.id}/content`];
        if (index < 2) await expect.poll(() => api.submissions.length).toBe(index + 2);
    }
    await expect.poll(() => api.document(PROJECT)?.groups[0].imageSequence.status).toBe("success");
    const sequence = api.document(PROJECT)!.groups[0].imageSequence;
    expect(sequence.steps.map((step: any) => step.configNodeId)).toEqual(ids);
    expect(sequence.steps.every((step: any) => step.status === "success" && step.outputNodeId)).toBe(true);
    expect(new Set(api.submissions.map(item => item.requestId)).size).toBe(3);
    const tasks = [...api.tasks.values()];
    for (let index = 1; index < 3; index++) {
        expect(api.submissions[index]!.sourceUrls).toHaveLength(1);
        const inputId = api.submissions[index]!.sourceUrls[0].split("/")[3];
        expect(sha(api.assetBytes.get(inputId)!)).toBe(sha(api.assetBytes.get(tasks[index - 1]!.id)!));
    }
    await info.attach("handoff-evidence.json", { body: JSON.stringify({ sequence, submissions: api.submissions.map(item => ({ requestId: item.requestId, prompt: item.prompt, sourceUrls: item.sourceUrls })), taskReads: api.taskReads, external: api.blocked, unexpected: api.unexpected }, null, 2), contentType: "application/json" });
});

test("a provider failure blocks downstream work and explicit continuation retries only the failed step", async ({ page, api }) => {
    api.taskStatus = "processing";
    const { first } = await openWorkflow(page, api);
    await first.getByRole("button", { name: "运行工作流", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    const firstTask = [...api.tasks.values()][0]!;
    firstTask.status = "success";
    firstTask.resultUrls = [`/api/assets/${firstTask.id}/content`];
    await expect.poll(() => api.submissions.length).toBe(2);
    const failedTask = [...api.tasks.values()][1]!;
    failedTask.status = "failed"; failedTask.failureReason = "HANDOFF_TEST_PROVIDER_FAILURE";
    await expect.poll(() => api.document(PROJECT)?.groups[0].imageSequence.status).toBe("failed");
    const stopped = api.document(PROJECT)!.groups[0].imageSequence;
    expect(stopped.steps.map((step: any) => step.status)).toEqual(["success", "failed", "idle"]);
    expect(api.submissions).toHaveLength(2);
    api.taskStatus = "success";
    await first.getByRole("button", { name: "继续工作流", exact: true }).click();
    await expect.poll(() => api.document(PROJECT)?.groups[0].imageSequence.status).toBe("success");
    expect(api.submissions).toHaveLength(4);
    expect(api.submissions.map(item => item.prompt.match(/HANDOFF_STEP_\d/)?.[0])).toEqual(["HANDOFF_STEP_1", "HANDOFF_STEP_2", "HANDOFF_STEP_2", "HANDOFF_STEP_3"]);
    expect(api.document(PROJECT)!.groups[0].imageSequence.steps[0].outputNodeId).toBe(stopped.steps[0].outputNodeId);
});

test("reload observes the accepted original task without POSTing or auto-starting later steps", async ({ page, api }) => {
    api.taskStatus = "processing";
    const { first } = await openWorkflow(page, api);
    await first.getByRole("button", { name: "运行工作流", exact: true }).click();
    await expect.poll(() => api.submissions.length).toBe(1);
    const original = [...api.tasks.values()][0]!;
    await expect.poll(() => api.document(PROJECT)?.nodes.some((node: any) => node.metadata?.imageTask?.taskId === original.id)).toBe(true);
    const readsBeforeReload = api.taskReads.length;
    await page.reload();
    await expect(page.getByRole("button", { name: "上传素材", exact: true })).toBeVisible();
    await expect.poll(() => api.taskReads.length).toBeGreaterThan(readsBeforeReload);
    expect(api.submissions).toHaveLength(1);
    original.status = "success"; original.resultUrls = [`/api/assets/${original.id}/content`];
    await expect.poll(() => api.document(PROJECT)?.nodes.some((node: any) => node.metadata?.sourceTaskId === original.id && node.metadata?.status === "success" && !node.metadata?.imageTask)).toBe(true);
    expect(api.submissions).toHaveLength(1);
    expect(api.document(PROJECT)!.groups[0].imageSequence.steps.slice(1).every((step: any) => step.status === "idle")).toBe(true);
    api.taskStatus = "success";
    await first.getByRole("button", { name: /^(运行|继续)工作流$/ }).click();
    await expect.poll(() => api.document(PROJECT)?.groups[0].imageSequence.status).toBe("success");
    expect(api.submissions).toHaveLength(3);
    expect(api.submissions.map(item => item.prompt.match(/HANDOFF_STEP_\d/)?.[0])).toEqual(["HANDOFF_STEP_1", "HANDOFF_STEP_2", "HANDOFF_STEP_3"]);
    expect(api.taskReads.every(path => [...api.tasks.keys()].some(id => path.endsWith(`/${id}`)))).toBe(true);
});

test("stopping during reference upload leaves an unsubmitted placeholder retryable", async ({ page, api }) => {
    let holdUploads = true;
    const uploads: Route[] = [];
    await page.route("**/api/assets/upload-request", route => {
        if (holdUploads) { uploads.push(route); return; }
        return route.fallback();
    });
    const { first } = await openWorkflow(page, api);
    await first.getByRole("button", { name: "运行工作流", exact: true }).click();
    await expect.poll(() => uploads.length).toBeGreaterThan(0);
    await expect.poll(() => api.document(PROJECT)?.connections.some((edge: any) => edge.kind === "generation-output")).toBe(true);
    expect(api.submissions).toHaveLength(0);
    expect(api.document(PROJECT)!.nodes.some((node: any) => node.metadata?.imageTask)).toBe(false);
    await first.getByRole("button", { name: "停止工作流", exact: true }).click();
    holdUploads = false;
    for (const route of uploads.splice(0)) await route.fallback();
    await expect.poll(() => api.document(PROJECT)?.groups[0].imageSequence.status).toBe("stopped");
    expect(api.document(PROJECT)!.groups[0].imageSequence.steps[0].status).toBe("idle");
    expect(api.submissions).toHaveLength(0);
    await first.getByRole("button", { name: "继续工作流", exact: true }).click();
    await expect.poll(() => api.document(PROJECT)?.groups[0].imageSequence.status).toBe("success");
    expect(api.submissions).toHaveLength(3);
});
