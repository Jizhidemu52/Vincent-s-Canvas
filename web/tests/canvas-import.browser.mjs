// Run against a source-serving Vite server, like canvas-indexeddb.browser.mjs.
// A new context owns every synthetic byte; no production APIs or user DB are used.
export async function verifyColdCanvasImport(page, origin = "http://127.0.0.1:4317") {
    const context = await page.context().browser().newContext();
    try {
        await context.route("**/*", route => {
            const url = new URL(route.request().url());
            if (url.origin !== origin || url.pathname.startsWith("/api/")) return route.abort("blockedbyclient");
            if (url.pathname === "/__cold-canvas-import-test__") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Cold import regression</title>" });
            return route.continue();
        });
        const tab = await context.newPage();
        await tab.goto(`${origin}/__cold-canvas-import-test__`);
        return await tab.evaluate(async () => {
            const [{ createZip }, { importCanvasArchive }, { useCanvasStore }, { getImageBlob }, { createWorkspaceStorage }] = await Promise.all([
                import("/src/lib/zip.ts"), import("/src/pages/canvas/import-canvas.ts"), import("/src/stores/canvas/use-canvas-store.ts"), import("/src/services/image-storage.ts"), import("/src/lib/workspace-storage.ts"),
            ]);
            if (!useCanvasStore.getState().hydrated) await new Promise(resolve => { const off = useCanvasStore.persist.onFinishHydration(() => { off(); resolve(); }); });
            const check = (condition, description) => { if (!condition) throw new Error(description); };
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#224e42"/></svg>';
            const files = Array.from({ length: 71 }, (_, i) => ({ storageKey: `image:cold-${i}`, path: `files/${i}.svg`, mimeType: "image/svg+xml", bytes: new Blob([svg]).size }));
            const source = { id: "cold-source", title: "冷启动原图回归", createdAt: "test", updatedAt: "test", nodes: files.map((file, i) => ({ id: `n-${i}`, type: "image", title: `图${i}`, width: 16, height: 16, position: { x: i * 20, y: 0 }, metadata: { storageKey: file.storageKey, content: `canvas-archive:${file.storageKey}` } })), connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
            const archive = await createZip([{ name: "projects.json", data: JSON.stringify({ app: "wireless-canvas", version: 3, projects: [{ project: source, files }] }) }, ...files.map(file => ({ name: file.path, data: new Blob([svg], { type: file.mimeType }) }))]);
            check(await importCanvasArchive(archive) === 1, "Cold archive did not import");
            const project = useCanvasStore.getState().projects[0];
            check(project.nodes.length === 71, "Imported nodes missing");
            for (const file of files) {
                const original = await getImageBlob(file.storageKey);
                check(original?.type === "image/svg+xml" && await original.text() === svg, "Original MIME/bytes changed");
            }
            // Lazy modules may create another store after import while images are being read.
            const later = createWorkspaceStorage("cold_import_late_store");
            await Promise.all([later.setItem("ready", true), ...files.map(file => getImageBlob(file.storageKey))]);
            check(await later.getItem("ready") === true, "Late store initialization failed");
            return { coldImport: true, imageCount: 71, originalBytesAndMimePreserved: true, lateStoreInitialization: true, projectSaved: useCanvasStore.getState().cloudStatus === "local" };
        });
    } finally { await context.close(); }
}
