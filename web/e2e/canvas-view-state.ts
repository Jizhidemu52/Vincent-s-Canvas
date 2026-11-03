import type { Page } from "@playwright/test";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { parseCanvasProject } from "../src/lib/canvas/canvas-project-codec";

type CanvasViewState = Pick<CanvasProject, "viewport" | "selectedNodeIds" | "history">;

/** View and undo state are browser-local, not fields of the cloud document. */
export async function readCanvasViewState(page: Page, projectId: string, ownerId = "00000000-0000-4000-8000-000000000099"): Promise<CanvasViewState | null> {
    const name = `wireless-canvas:canvas_store:oa:user:${encodeURIComponent(ownerId)}`;
    const keys = {
        document: JSON.stringify([`${name}:project-documents:v1`, projectId]),
        view: JSON.stringify([`${name}:project-view:v1`, projectId]),
    };
    const saved = await page.evaluate(keys => new Promise<{ document?: string; view?: Pick<CanvasViewState, "viewport" | "selectedNodeIds"> }>((resolve, reject) => {
        const opening = indexedDB.open("wireless-canvas");
        opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error("Canvas storage is not initialized")); };
        opening.onerror = () => reject(opening.error || new Error("Cannot read canvas storage"));
        opening.onblocked = () => reject(new Error("Canvas storage is blocked"));
        opening.onsuccess = () => {
            const database = opening.result;
            database.onversionchange = () => database.close();
            let transaction: IDBTransaction;
            try { transaction = database.transaction("app_state", "readonly"); }
            catch (error) { database.close(); reject(error); return; }
            const result: { document?: string; view?: Pick<CanvasViewState, "viewport" | "selectedNodeIds"> } = {};
            transaction.onabort = () => { database.close(); reject(transaction.error || new Error("Canvas storage read aborted")); };
            transaction.onerror = () => { database.close(); reject(transaction.error || new Error("Canvas storage read failed")); };
            transaction.oncomplete = () => { database.close(); resolve(result); };
            const store = transaction.objectStore("app_state");
            const document = store.get(keys.document);
            document.onsuccess = () => {
                if (document.result !== undefined && typeof document.result !== "string") { transaction.abort(); return; }
                result.document = document.result;
            };
            const view = store.get(keys.view);
            view.onsuccess = () => { result.view = view.result; };
        };
    }), keys);
    if (saved.document === undefined) return null;
    const project = parseCanvasProject(saved.document);
    if (project.id !== projectId) throw new Error("Persisted canvas ID does not match its owner-scoped key");
    const view = saved.view;
    if (view && (!view.viewport || ![view.viewport.x, view.viewport.y, view.viewport.k].every(Number.isFinite) || view.viewport.k <= 0)) {
        throw new Error("Persisted canvas view is invalid");
    }
    return { viewport: view?.viewport ?? project.viewport, selectedNodeIds: view?.selectedNodeIds ?? project.selectedNodeIds, history: project.history };
}
