import { expect, test, IMAGE } from "./fixtures";

test("returning to a canvas looks up an uncertain request and installs the late original without a generation or recovery POST", async ({ page, api }, info) => {
    const id = "70000000-0000-4000-8000-000000000096", taskId = "70000000-0000-4000-8000-000000000097";
    const ownerId = "00000000-0000-4000-8000-000000000099", requestId = "canvas-visibility-original:0", nodeId = "original-result";
    const node = { id: nodeId, type: "image", title: "配色原结果", position: { x: 0, y: 0 }, width: 320, height: 240,
        metadata: { status: "error", errorDetails: "原任务待核查", imageTask: { ownerId, projectId: id, requestId, resultIndex: 0 } } };
    const document = { id, title: "原任务回填", createdAt: "2026-11-19T01:00:00Z", updatedAt: "2026-11-19T01:00:00Z",
        nodes: [node], connections: [], groups: [], chatSessions: [], activeChatId: null, backgroundMode: "dots",
        showImageInfo: false, viewport: { x: 420, y: 280, k: 1 }, selectedNodeIds: [], history: { past: [], future: [] } };
    api.documents.set(id, { id, revision: 1, document, deleted: false, updatedAt: document.updatedAt });
    api.assetBytes.set(taskId, IMAGE);
    let ready = false, reads = 0;
    const writes: string[] = [];
    await page.route("**/api/tasks/**", route => {
        const req = route.request(), path = decodeURIComponent(new URL(req.url()).pathname);
        if (req.method() !== "GET") { writes.push(path); return route.abort(); }
        if (path !== `/api/tasks/by-request/${requestId}`) return route.fallback();
        reads++;
        return ready ? route.fulfill({ json: { task: { id: taskId, userId: ownerId, requestId, status: "success",
            resultUrls: [`/api/assets/${taskId}/content`], failureReason: null } } }) : route.fulfill({ status: 404, json: {} });
    });
    await page.goto(`/canvas/${id}`);
    await expect.poll(() => reads).toBeGreaterThan(0);
    await expect.poll(() => api.documents.get(id)!.document.nodes[0].metadata.errorDetails).not.toBe("原任务待核查");
    ready = true;
    await page.evaluate(() => window.document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => api.documents.get(id)!.document.nodes[0].metadata.status).toBe("success");
    expect(api.documents.get(id)!.document.nodes[0].metadata.sourceTaskId).toBe(taskId);
    expect(api.submissions).toEqual([]);
    expect(writes).toEqual([]);
    await page.locator(`[data-node-id="${nodeId}"]`).screenshot({ path: info.outputPath("canvas-late-original.png") });
});
