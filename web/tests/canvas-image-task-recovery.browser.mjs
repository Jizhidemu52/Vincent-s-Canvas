// Run against the real source-serving Vite app. Every scenario owns a fresh
// browser context and IndexedDB; all business requests are fulfilled or blocked.
// No production API, provider endpoint, or user's browser storage is used.
export async function verifyCanvasImageTaskRecovery(page, origin = "http://127.0.0.1:4319", options = {}) {
    const browser = page.context().browser();
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const waitFor = async (read, message) => {
        const deadline = performance.now() + 30_000;
        do {
            if (await read()) return;
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (performance.now() < deadline);
        throw new Error(message);
    };
    const fixtureUser = {
        id: "browser-recovery-owner", username: "browser-fixture", displayName: "恢复回归测试",
        role: "designer", status: "active", mustChangePassword: false, mfaEnabled: false,
        email: null, employeeNo: null, departmentId: null, departmentName: null,
        groupId: null, groupName: null, groupRole: null, creditBalance: 0, creditLimit: 0,
        monthlyCreditLimit: 0, temporaryCreditAdjustment: 0, creditPeriodStart: "", creditResetAt: "",
    };
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="#215e4d"/><text x="28" y="91" font-size="30" fill="white">Recovered original</text></svg>';
    const scenarios = ["direct-success", "request-only-success", "paused", "query-error", "failed", "cancelled"];
    const results = [];

    for (const scenario of scenarios) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
        const tab = await context.newPage();
        const projectId = `recovery-${scenario}`;
        const nodeId = `original-${scenario}`;
        const requestId = `fixture-${scenario}:0`;
        const taskId = `task-${scenario}`;
        const calls = [];
        const unexpected = [];
        const consoleErrors = [];
        const pageErrors = [];
        let taskQueries = 0;
        const terminal = scenario === "direct-success" || scenario === "request-only-success" ? "success" : scenario;
        const baseTask = { id: taskId, requestId, ownerUserId: fixtureUser.id, userId: fixtureUser.id, operationType: "image_generation", resultUrls: ["/api/assets/recovery-result/content"], failureReason: null };
        tab.on("pageerror", error => pageErrors.push(error.message));
        tab.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
        await context.route("**/*", async route => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.origin !== origin) {
                unexpected.push({ method: request.method(), url: request.url(), reason: "external blocked" });
                return route.abort("blockedbyclient");
            }
            if (url.pathname === "/__canvas-image-recovery-fixture__") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Isolated recovery fixture</title>" });
            if (!url.pathname.startsWith("/api/")) return route.continue();
            const call = { method: request.method(), path: url.pathname + url.search };
            calls.push(call);
            const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
            // The only permitted write is synthetic metadata sync, handled here.
            if (url.pathname === "/api/projects/sync" && request.method() === "POST") {
                const value = request.postDataJSON();
                return json({ project: { externalId: value.externalId, name: value.name } });
            }
            if (request.method() !== "GET") {
                unexpected.push({ ...call, reason: "business mutation blocked" });
                return json({ message: "Browser recovery regression blocks all generation and business mutations" }, 405);
            }
            if (url.pathname === "/api/deployment") return json({ authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false });
            if (url.pathname === "/api/auth/session") return json({ user: fixtureUser });
            if (url.pathname === "/api/modules") return json({ modules: ["canvas", "image", "assets", "gpt-chat", "performance"].map(moduleKey => ({ moduleKey, enabled: true, updatedAt: "fixture" })) });
            if (url.pathname === "/api/models") return json({ models: [], prices: [], tools: [] });
            if (url.pathname === "/api/generation-capabilities") return json({ models: [] });
            if (url.pathname === "/api/assets/recovery-result/content") return route.fulfill({ contentType: "image/svg+xml", body: svg });
            const expectedDirect = `/api/tasks/${taskId}`;
            const expectedRequest = `/api/tasks/by-request/${encodeURIComponent(requestId)}`;
            if (url.pathname === expectedDirect || url.pathname === expectedRequest) {
                taskQueries++;
                if (scenario === "query-error") return json({ message: "Fixture task lookup failed" }, 503);
                const status = terminal === "success" && taskQueries === 1 ? "processing" : terminal;
                return json({ task: { ...baseTask, status, failureReason: status === "paused" ? "原任务已暂停，请核查，不会重新提交" : status === "failed" || status === "cancelled" ? `原任务 ${status}` : null } });
            }
            unexpected.push({ ...call, reason: "unmocked business query blocked" });
            return json({ message: `Unmocked browser fixture endpoint: ${url.pathname}` }, 404);
        });

        try {
            await tab.goto(`${origin}/__canvas-image-recovery-fixture__`);
            const seeded = await tab.evaluate(async ({ projectId, nodeId, requestId, taskId, ownerId, requestOnly }) => {
                const { writeCanvasProjects, readCanvasProjects } = await import("/src/lib/canvas/canvas-project-storage.ts");
                const imageTask = { requestId, ownerId, projectId, resultIndex: 0, ...(requestOnly ? {} : { taskId }) };
                const project = {
                    id: projectId, title: "图片任务刷新恢复回归", createdAt: "fixture", updatedAt: "fixture",
                    nodes: [{ id: nodeId, type: "image", title: "恢复占位图", width: 320, height: 160, position: { x: 360, y: 240 }, metadata: { status: "loading", content: "", prompt: "Synthetic recovery fixture only", imageTask } }],
                    connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
                };
                await writeCanvasProjects("wireless-canvas:canvas_store", new Map([[projectId, { base: null, value: project, conflictId: "fixture", savedAt: "fixture" }]]));
                return (await readCanvasProjects("wireless-canvas:canvas_store"))[0];
            }, { projectId, nodeId, requestId, taskId, ownerId: fixtureUser.id, requestOnly: scenario === "request-only-success" });
            check(seeded?.nodes?.[0]?.metadata?.imageTask?.requestId === requestId, "Fixture task binding was not persisted");
            const initialQueryResponse = tab.waitForResponse(response => {
                const path = new URL(response.url()).pathname;
                return response.request().method() === "GET" && (path === `/api/tasks/${taskId}` || path === `/api/tasks/by-request/${encodeURIComponent(requestId)}`);
            });
            await tab.goto(`${origin}/canvas/${projectId}`, { waitUntil: "domcontentloaded" });
            await initialQueryResponse;
            const expectedStatus = terminal === "success" ? "success" : "error";
            await waitFor(() => tab.evaluate(async ({ projectId, nodeId, expectedStatus, taskId, queryError }) => {
                const { readCanvasProjects } = await import("/src/lib/canvas/canvas-project-storage.ts");
                const project = (await readCanvasProjects("wireless-canvas:canvas_store")).find(value => value.id === projectId);
                const metadata = project?.nodes.find(value => value.id === nodeId)?.metadata;
                return metadata?.status === expectedStatus && (queryError ? metadata.errorDetails?.includes("Fixture task lookup failed") : metadata.sourceTaskId === taskId);
            }, { projectId, nodeId, expectedStatus, taskId, queryError: scenario === "query-error" }), `Persisted node did not become ${expectedStatus}`);
            const readState = () => tab.evaluate(async ({ projectId, nodeId }) => {
                const { readCanvasProjects } = await import("/src/lib/canvas/canvas-project-storage.ts");
                const project = (await readCanvasProjects("wireless-canvas:canvas_store")).find(value => value.id === projectId);
                const node = project?.nodes.find(value => value.id === nodeId);
                const { getImageBlob } = await import("/src/services/image-storage.ts");
                const blob = node?.metadata?.storageKey ? await getImageBlob(node.metadata.storageKey) : null;
                return { projectCount: (await readCanvasProjects("wireless-canvas:canvas_store")).length, nodeCount: project?.nodes.length, node, imageText: blob ? await blob.text() : null, imageType: blob?.type };
            }, { projectId, nodeId });
            let beforeReload = await readState();
            check(beforeReload.projectCount === 1 && beforeReload.nodeCount === 1, "Recovery created another project or result node");
            check(beforeReload.node.id === nodeId && beforeReload.node.position.x === 360 && beforeReload.node.position.y === 240, "Original node ID or position changed");
            check(beforeReload.node.metadata.sourceTaskId === taskId || scenario === "query-error", "Recovered task ID was not retained");
            const node = tab.locator(`[data-node-id="${nodeId}"]`);
            await node.waitFor({ state: "visible", timeout: 15_000 });

            if (terminal === "success") {
                check(!beforeReload.node.metadata.imageTask, "Completed task binding was not cleared");
                check(beforeReload.imageText === svg && beforeReload.imageType === "image/svg+xml", "Recovered original image was not persisted losslessly");
                await node.getByAltText("恢复占位图", { exact: true }).waitFor({ state: "visible" });
            } else if (scenario === "paused" || scenario === "query-error") {
                check(beforeReload.node.metadata.imageTask?.requestId === requestId, "Unresolved original binding was discarded");
                await node.getByRole("button", { name: "恢复查询", exact: true }).waitFor({ state: "visible" });
                const previousQueries = taskQueries;
                const retryResponse = tab.waitForResponse(response => new URL(response.url()).pathname === `/api/tasks/${taskId}` && response.request().method() === "GET");
                await node.getByRole("button", { name: "恢复查询", exact: true }).click();
                await retryResponse;
                await waitFor(() => tab.evaluate(async ({ projectId, nodeId }) => {
                    const { readCanvasProjects } = await import("/src/lib/canvas/canvas-project-storage.ts");
                    const node = (await readCanvasProjects("wireless-canvas:canvas_store")).find(value => value.id === projectId)?.nodes.find(value => value.id === nodeId);
                    return node?.metadata.status === "error";
                }, { projectId, nodeId }), "Retry query did not persist its error state");
                check(taskQueries > previousQueries, "Recovery button did not query the original task");
                beforeReload = await readState();
            } else {
                check(!beforeReload.node.metadata.imageTask, "Failed/cancelled terminal binding was not cleared");
                await node.getByRole("button", { name: "重试", exact: true }).waitFor({ state: "visible" });
            }

            const queriesBeforeReload = taskQueries;
            const reloadResponse = scenario === "paused" || scenario === "query-error"
                ? tab.waitForResponse(response => new URL(response.url()).pathname === `/api/tasks/${taskId}` && response.request().method() === "GET") : null;
            await tab.reload({ waitUntil: "domcontentloaded" });
            if (reloadResponse) await reloadResponse;
            await tab.locator(`[data-node-id="${nodeId}"]`).waitFor({ state: "visible", timeout: 15_000 });
            if (terminal === "success") await tab.locator(`[data-node-id="${nodeId}"]`).getByAltText("恢复占位图", { exact: true }).waitFor({ state: "visible" });
            if (scenario === "paused" || scenario === "query-error") await tab.locator(`[data-node-id="${nodeId}"]`).getByRole("button", { name: "恢复查询", exact: true }).waitFor({ state: "visible" });
            const afterReload = await readState();
            check(afterReload.nodeCount === 1 && afterReload.node.id === nodeId, "Reload duplicated or lost the original result node");
            check(afterReload.node.position.x === 360 && afterReload.node.position.y === 240, "Reload moved the original node");
            check(afterReload.node.metadata.status === expectedStatus, "Reload lost the recovered status");
            if (terminal === "success") {
                check(taskQueries === queriesBeforeReload, "Reload unnecessarily queried an already completed task");
                check(afterReload.node.metadata.storageKey === beforeReload.node.metadata.storageKey && afterReload.imageText === svg, "Reload lost the persisted original image");
            }
            const taskCalls = calls.filter(call => call.path.startsWith("/api/tasks"));
            check(taskCalls.length > 0 && taskCalls.every(call => call.method === "GET"), "Recovery attempted task mutation or made no task query");
            check(!taskCalls.some(call => call.path === "/api/tasks"), "Recovery used the broad task list instead of a precise query");
            if (scenario === "request-only-success") {
                check(taskCalls[0].path === `/api/tasks/by-request/${encodeURIComponent(requestId)}`, "Missing task ID did not use the exact request endpoint");
                check(taskCalls.slice(1).every(call => call.path === `/api/tasks/${taskId}`), "Recovered ID was not used for subsequent queries");
            } else check(taskCalls.every(call => call.path === `/api/tasks/${taskId}`), "Bound task used a different task lookup");
            check(unexpected.length === 0, `Unexpected network attempts: ${JSON.stringify(unexpected)}`);
            check(pageErrors.length === 0, `React page errors: ${pageErrors.join("; ")}`);
            if (options.screenshotDirectory && (scenario === "direct-success" || scenario === "paused")) await tab.screenshot({ path: `${options.screenshotDirectory}/${scenario}.png` });
            const result = { scenario, passed: true, nodeId, projectId, queryCount: taskQueries, taskCalls, taskMutations: 0, sameNodeAndPosition: true, persistedAcrossReload: true, originalImageBytesPreserved: terminal === "success", status: afterReload.node.metadata.status, bindingRetained: Boolean(afterReload.node.metadata.imageTask), pageErrors, consoleErrors, calls };
            results.push(result);
            await options.onScenario?.(result);
        } catch (error) {
            const result = { scenario, passed: false, error: error instanceof Error ? error.message : String(error), taskQueries, calls, unexpected, pageErrors, consoleErrors, pageText: (await tab.locator("body").innerText().catch(() => "")).slice(0, 4000) };
            if (options.screenshotDirectory) await tab.screenshot({ path: `${options.screenshotDirectory}/${scenario}-failed.png` }).catch(() => {});
            results.push(result);
            await options.onScenario?.(result);
        } finally {
            await context.close();
        }
    }
    return { passed: results.every(result => result.passed), origin, isolatedContexts: results.length, mockedBusinessApi: true, realGenerationRequests: 0, results };
}

/** Exercise the actual quick-generate UI, with its sole POST intercepted locally. */
export async function verifyCanvasImageTaskSubmissionReload(page, origin = "http://127.0.0.1:4319", options = {}) {
    const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
    const tab = await context.newPage();
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const waitFor = async (read, message) => {
        const deadline = performance.now() + 30_000;
        do { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 100)); } while (performance.now() < deadline);
        throw new Error(message);
    };
    const projectId = "recovery-real-quick-submit";
    const ownerId = "browser-submit-owner";
    const taskId = "browser-new-task";
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="#2b5278"/><text x="18" y="91" font-size="26" fill="white">Submitted then recovered</text></svg>';
    const user = { id: ownerId, username: "fixture", displayName: "提交恢复测试", role: "designer", status: "active", creditBalance: 0, mustChangePassword: false };
    const model = { id: "fixture-image-model", modelId: "gpt-image-2", name: "浏览器回归模型", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 };
    const calls = [];
    const unexpected = [];
    const pageErrors = [];
    const consoleErrors = [];
    let submittedRequest = null;
    let beforePost = null;
    let beforeFirstPoll = null;
    let canvasNavigations = 0;
    tab.on("pageerror", error => pageErrors.push(error.message));
    tab.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    const readProject = () => tab.evaluate(async projectId => {
        const { readCanvasProjects } = await import("/src/lib/canvas/canvas-project-storage.ts");
        return (await readCanvasProjects("wireless-canvas:canvas_store")).find(project => project.id === projectId);
    }, projectId);
    await context.route("**/*", async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) { unexpected.push({ url: request.url(), reason: "external blocked" }); return route.abort("blockedbyclient"); }
        if (url.pathname === "/__canvas-image-submit-fixture__") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Isolated submission fixture</title>" });
        if (!url.pathname.startsWith("/api/")) {
            if (url.pathname === `/canvas/${projectId}` && request.isNavigationRequest()) canvasNavigations++;
            return route.continue();
        }
        const call = { method: request.method(), path: url.pathname + url.search, navigation: canvasNavigations };
        calls.push(call);
        const json = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
        if (url.pathname === "/api/projects/sync" && request.method() === "POST") {
            const value = request.postDataJSON();
            return json({ project: { externalId: value.externalId, name: value.name } });
        }
        if (url.pathname === "/api/tasks" && request.method() === "POST") {
            submittedRequest = request.postDataJSON();
            beforePost = await readProject();
            return json({ task: { id: taskId, requestId: submittedRequest.requestId, status: "processing" } });
        }
        if (request.method() !== "GET") { unexpected.push({ ...call, reason: "unexpected mutation blocked" }); return json({ message: "No real mutation allowed" }, 405); }
        if (url.pathname === "/api/deployment") return json({ authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false });
        if (url.pathname === "/api/auth/session") return json({ user });
        if (url.pathname === "/api/modules") return json({ modules: ["canvas", "image", "assets", "gpt-chat"].map(moduleKey => ({ moduleKey, enabled: true, updatedAt: "fixture" })) });
        if (url.pathname === "/api/models") return json({ models: [model], prices: [], tools: [] });
        if (url.pathname === "/api/generation-capabilities") return json({ models: [] });
        if (url.pathname === "/api/assets/submission-result/content") return route.fulfill({ contentType: "image/svg+xml", body: svg });
        if (url.pathname === `/api/tasks/${taskId}`) {
            beforeFirstPoll ||= await readProject();
            return json({ task: { id: taskId, requestId: submittedRequest?.requestId, ownerUserId: ownerId, userId: ownerId, status: canvasNavigations >= 2 ? "success" : "processing", operationType: "image_generation", resultUrls: ["/api/assets/submission-result/content"], failureReason: null } });
        }
        unexpected.push({ ...call, reason: "unmocked endpoint blocked" });
        return json({ message: "Unmocked browser fixture endpoint" }, 404);
    });
    try {
        await tab.goto(`${origin}/__canvas-image-submit-fixture__`);
        await tab.evaluate(async projectId => {
            const { writeCanvasProjects } = await import("/src/lib/canvas/canvas-project-storage.ts");
            const project = { id: projectId, title: "真实快生提交与刷新恢复", createdAt: "fixture", updatedAt: "fixture", nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
            await writeCanvasProjects("wireless-canvas:canvas_store", new Map([[projectId, { base: null, value: project, conflictId: "fixture", savedAt: "fixture" }]]));
        }, projectId);
        await tab.goto(`${origin}/canvas/${projectId}`, { waitUntil: "domcontentloaded" });
        const panel = tab.getByTestId("canvas-quick-generate-panel");
        await waitFor(async () => await panel.isVisible() || await tab.getByRole("button", { name: "展开创建面板", exact: true }).isVisible(), "Canvas create panel did not become available");
        if (!await panel.isVisible()) await tab.getByRole("button", { name: "展开创建面板", exact: true }).click();
        await panel.getByRole("textbox", { name: "描述图像", exact: true }).fill("本地模拟任务：验证提交后刷新恢复");
        await panel.getByRole("button", { name: /生成设置/ }).click();
        const decrease = panel.getByRole("button", { name: "减少生成张数", exact: true });
        if (await decrease.count()) {
            for (let attempts = 0; attempts < 10 && await decrease.isEnabled(); attempts++) await decrease.click();
            check(!await decrease.isEnabled(), "Could not select one generation result");
        }
        await panel.getByRole("button", { name: "生成", exact: true }).click();
        await waitFor(() => beforeFirstPoll !== null, "Quick generation did not submit and start observing its task");
        const beforePostNode = beforePost?.nodes.find(node => node.metadata?.imageTask?.requestId === submittedRequest?.requestId);
        check(beforePost?.nodes.length === 1 && Boolean(beforePostNode), "Request binding was not persisted when POST was intercepted");
        check(beforePostNode.metadata.imageTask.ownerId === ownerId && beforePostNode.metadata.imageTask.projectId === projectId && beforePostNode.metadata.imageTask.resultIndex === 0, "Persisted request binding has wrong owner/project/result");
        check(!beforePostNode.metadata.imageTask.taskId, "Fixture unexpectedly had a task ID before the POST response");
        const submittedNode = beforeFirstPoll.nodes.find(node => node.id === beforePostNode.id);
        check(submittedNode?.metadata?.imageTask?.taskId === taskId, "onSubmitted did not persist task ID before polling");
        check(submittedRequest?.projectId === projectId && submittedRequest?.parameters?.count === 1, "UI submitted the wrong project or image count");
        check(submittedNode.metadata.status === "loading", "Task completed before the intended refresh");
        if (options.screenshotDirectory) await tab.screenshot({ path: `${options.screenshotDirectory}/quick-submit-before-refresh.png` });
        await tab.reload({ waitUntil: "domcontentloaded" });
        await waitFor(async () => (await readProject())?.nodes.find(node => node.id === submittedNode.id)?.metadata?.status === "success", "Submitted task did not refill its original node after reload");
        const recovered = await readProject();
        const node = recovered.nodes.find(node => node.id === submittedNode.id);
        check(recovered.nodes.length === 1 && node, "Reload created a duplicate result node");
        check(node.position.x === submittedNode.position.x && node.position.y === submittedNode.position.y, "Recovery moved the existing placeholder");
        check(!node.metadata.imageTask && node.metadata.sourceTaskId === taskId, "Recovered task metadata was not finalized");
        const content = await tab.evaluate(async storageKey => {
            const { getImageBlob } = await import("/src/services/image-storage.ts");
            const blob = await getImageBlob(storageKey);
            return { text: await blob.text(), type: blob.type };
        }, node.metadata.storageKey);
        check(content.text === svg && content.type === "image/svg+xml", "Newly submitted result bytes were not preserved");
        await tab.locator(`[data-node-id="${node.id}"]`).getByAltText(node.title, { exact: true }).waitFor({ state: "visible" });
        const taskCalls = calls.filter(call => call.path.startsWith("/api/tasks"));
        const taskPosts = taskCalls.filter(call => call.method === "POST" && call.path === "/api/tasks");
        const cancelCalls = taskCalls.filter(call => /\/cancel(?:\?|$)/.test(call.path));
        check(taskPosts.length === 1, `Expected exactly one mocked task POST, saw ${taskPosts.length}`);
        check(cancelCalls.length === 0, "Refreshing the page cancelled the server task");
        check(taskCalls.some(call => call.method === "GET" && call.navigation >= 2), "Reload did not query the previously submitted task");
        check(unexpected.length === 0, `Unexpected network attempts: ${JSON.stringify(unexpected)}`);
        check(pageErrors.length === 0, `React page errors: ${pageErrors.join("; ")}`);
        await tab.locator(".cw-panel-loading").waitFor({ state: "hidden" });
        if (options.screenshotDirectory) await tab.screenshot({ path: `${options.screenshotDirectory}/quick-submit-after-refresh.png` });
        return { scenario: "quick-submit-reload", passed: true, requestPersistedBeforePost: true, taskIdPersistedBeforePoll: true, mockTaskPosts: taskPosts.length, cancelRequests: cancelCalls.length, realGenerationRequests: 0, sameNodeAndPosition: true, recoveredAfterReload: true, originalImageBytesPreserved: true, nodeId: node.id, taskCalls, calls, pageErrors, consoleErrors };
    } catch (error) {
        if (options.screenshotDirectory) await tab.screenshot({ path: `${options.screenshotDirectory}/quick-submit-failed.png` }).catch(() => {});
        return { scenario: "quick-submit-reload", passed: false, error: error instanceof Error ? error.message : String(error), submittedRequest, beforePost, beforeFirstPoll, calls, unexpected, pageErrors, consoleErrors, pageText: (await tab.locator("body").innerText().catch(() => "")).slice(0, 5000) };
    } finally { await context.close(); }
}
