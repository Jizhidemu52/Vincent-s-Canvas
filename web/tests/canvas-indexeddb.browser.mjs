// Run through browser_run_code_unsafe(filename) with a local Vite preview. Uses a
// fresh context: its databases, tabs and fixture projects never touch user data.
async function verifyCanvasIndexedDb(page, origin = "http://127.0.0.1:3301") {
    const context = await page.context().browser().newContext();
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    try {
        await context.route("**/__canvas-persistence-test__", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Canvas persistence tests</title>" }));
        const tabs = await Promise.all([context.newPage(), context.newPage()]);
        await Promise.all(tabs.map(tab => tab.goto(`${origin}/__canvas-persistence-test__`, { waitUntil: "domcontentloaded" })));
        await Promise.all(tabs.map(tab => tab.evaluate(async () => {
            Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
            const { updateCanvasStorage } = await import("/src/lib/canvas/canvas-atomic-storage.ts");
            const { localForageStorage } = await import("/src/lib/localforage-storage.ts");
            window.canvasFixture = { update: updateCanvasStorage, read: key => localForageStorage.getItem(key) };
        })));
        await tabs[0].evaluate(async () => {
            await window.canvasFixture.update("canvas-atomic-counter", () => "0");
            await window.canvasFixture.update("wireless-canvas:canvas_store", () => JSON.stringify({ version: 0, state: { projects: [{
                id: "shared-fixture", title: "事务回归画布", createdAt: "old", updatedAt: "old", backgroundMode: "dots", showImageInfo: false,
                viewport: { x: 0, y: 0, k: 1 }, activeChatId: null, chatSessions: [], connections: [],
                nodes: [
                    { id: "a", type: "image", title: "A", width: 640, height: 320, position: { x: 0, y: 0 }, metadata: { content: "data:image/png;base64,b3JpZ2luYWw=", storageKey: "image:original" } },
                    { id: "b", type: "text", title: "B", width: 300, height: 200, position: { x: 800, y: 0 }, metadata: { content: "原始说明" } },
                ],
            }] } }));
        });
        await Promise.all(tabs.map(tab => tab.evaluate(async () => {
            const { useCanvasStore, flushCanvasPersistence } = await import("/src/stores/canvas/use-canvas-store.ts");
            if (!useCanvasStore.persist.hasHydrated()) await new Promise(resolve => { const off = useCanvasStore.persist.onFinishHydration(() => { off(); resolve(); }); });
            Object.assign(window.canvasFixture, { store: useCanvasStore, flush: flushCanvasPersistence });
        })));
        await Promise.all(tabs.map((tab, index) => tab.evaluate(async index => {
            const { store, flush } = window.canvasFixture;
            const nodes = store.getState().projects[0].nodes.map(node => node.id === (index ? "b" : "a") ? { ...node, position: { ...node.position, y: index ? 200 : 100 } } : node);
            store.getState().updateProject("shared-fixture", { nodes });
            await flush();
        }, index)));
        const combined = await tabs[0].evaluate(async () => JSON.parse(await window.canvasFixture.read("wireless-canvas:canvas_store")).state.projects);
        check(combined.length === 1 && combined[0].nodes[0].position.y === 100 && combined[0].nodes[1].position.y === 200, "Concurrent real stores lost an independent move");
        check(combined[0].nodes[0].metadata.content === "data:image/png;base64,b3JpZ2luYWw=", "Original image bytes changed");

        await Promise.all(tabs.map(tab => tab.evaluate(async () => {
            await Promise.all(Array.from({ length: 25 }, () => window.canvasFixture.update("canvas-atomic-counter", current => String(Number(current) + 1))));
        })));
        const counter = await tabs[0].evaluate(() => window.canvasFixture.read("canvas-atomic-counter"));
        check(counter === "50", `Read/merge/write was not atomic: ${counter}/50 updates retained`);

        const rollback = await tabs[0].evaluate(async () => {
            const { update, read } = window.canvasFixture;
            let mergeError = "", quotaError = "";
            try { await update("canvas-atomic-counter", () => { throw new Error("merge fixture failure"); }); }
            catch (error) { mergeError = error.message; }
            const afterMergeFailure = await read("canvas-atomic-counter");
            const originalPut = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function (value, key) {
                if (key === "canvas-atomic-counter") throw new DOMException("quota fixture failure", "QuotaExceededError");
                return originalPut.call(this, value, key);
            };
            try { await update("canvas-atomic-counter", () => "corrupt"); }
            catch (error) { quotaError = error.name; }
            finally { IDBObjectStore.prototype.put = originalPut; }
            const afterQuotaFailure = await read("canvas-atomic-counter");
            await update("canvas-atomic-counter", current => String(Number(current) + 1));
            return { mergeError, quotaError, afterMergeFailure, afterQuotaFailure, afterRetry: await read("canvas-atomic-counter") };
        });
        check(rollback.mergeError === "merge fixture failure" && rollback.afterMergeFailure === "50", "Merge failure did not roll back atomically");
        check(rollback.quotaError === "QuotaExceededError" && rollback.afterQuotaFailure === "50" && rollback.afterRetry === "51", "Failed storage write changed the original or prevented retry");

        await tabs[0].evaluate(async () => { window.canvasFixture.store.getState().renameProject("shared-fixture", "窗口 A 名称"); await window.canvasFixture.flush(); });
        await tabs[1].evaluate(async () => { window.canvasFixture.store.getState().renameProject("shared-fixture", "窗口 B 名称"); await window.canvasFixture.flush(); });
        const conflicts = await tabs[1].evaluate(async () => ({ saved: JSON.parse(await window.canvasFixture.read("wireless-canvas:canvas_store")).state.projects, visible: window.canvasFixture.store.getState().projects }));
        const copy = conflicts.saved.find(project => project.id !== "shared-fixture");
        check(conflicts.saved.length === 2 && copy?.title.includes("窗口 A 名称") && copy.title.includes("保存冲突副本"), "A same-field conflict was not recoverable");
        check(conflicts.visible.some(project => project.id === copy.id), "Conflict copy was not discoverable in the current project list");
        check(copy.nodes[0].position.y === 100 && copy.nodes[1].position.y === 200, "Conflict backup lost earlier merged work");
        return { browser: "Chromium", locksDisabled: true, concurrentStoresMerged: true, atomicUpdates: 50, rollbackVerified: true, quotaFailureRetryVerified: true, conflictCopyVisible: true, originalImagePreserved: true };
    } finally {
        await context.close();
    }
}
