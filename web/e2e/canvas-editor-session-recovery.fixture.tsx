import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { CanvasEditorSession, type CanvasEditorFlushRef, type CanvasEditorRecoveryRef, type CanvasEditorWriteCapability } from "../src/pages/canvas/canvas-editor-session";
import { flushCanvasPersistence, useCanvasStore, type CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { readCanvasProject, writeCanvasProjects } from "../src/lib/canvas/canvas-project-storage";
import "../src/styles/globals.css";

const projectId = new URLSearchParams(location.search).get("project") || "session-recovery";
const storageKey = "wireless-canvas:canvas_store";
const capabilities: CanvasEditorWriteCapability[] = [];
const probe = {
    mounts: 0, unmounts: 0, instances: 0, flushes: 0, backups: 0, discards: 0, writes: 0, storeCommits: 0,
    backupFailure: false, holdBackup: false,
    events: [] as string[], backedUpDrafts: [] as string[], discardSnapshots: [] as string[],
    mountsWritable: [] as boolean[], capabilities,
    releaseBackup: () => {},
    save: async () => {},
    write: (index = capabilities.length - 1) => {
        if (!capabilities[index]?.current) return false;
        probe.writes++;
        return true;
    },
};

declare global { interface Window { __editorSessionFixture: typeof probe } }
window.__editorSessionFixture = probe;

function Editor({ flushRef, writable, recoveryRef }: { flushRef: CanvasEditorFlushRef; writable: CanvasEditorWriteCapability; recoveryRef: CanvasEditorRecoveryRef }) {
    const [instance] = useState(() => ++probe.instances);
    const [draft, setDraft] = useState(() => useCanvasStore.getState().openProject(projectId)?.title || "missing durable fixture");
    const draftRef = useRef(draft);
    draftRef.current = draft;
    useEffect(() => {
        probe.mounts++;
        probe.mountsWritable.push(writable.current);
        probe.events.push(`mount:${instance}`);
        if (!capabilities.includes(writable)) capabilities.push(writable);
        const save = async () => {
            if (!await writable.ensureWritable()) throw new Error("fixture refused revoked writer");
            useCanvasStore.getState().updateProject(projectId, { title: draftRef.current });
            await flushCanvasPersistence();
        };
        const flush = async () => { probe.flushes++; await save(); };
        const recovery = {
            backup: async () => {
                probe.backups++;
                probe.events.push("backup:start");
                const snapshot = draftRef.current;
                if (probe.holdBackup) await new Promise<void>(resolve => { probe.releaseBackup = resolve; });
                if (probe.backupFailure) { probe.events.push("backup:failed"); throw new Error("fixture backup failed"); }
                probe.backedUpDrafts.push(snapshot);
                probe.events.push("backup:done");
            },
            discardPending: () => {
                probe.discards++;
                probe.discardSnapshots.push(useCanvasStore.getState().openProject(projectId)?.title || "missing");
                probe.events.push("discard");
            },
        };
        probe.save = save;
        flushRef.current = flush;
        recoveryRef.current = recovery;
        return () => {
            probe.unmounts++;
            probe.events.push(`unmount:${instance}`);
            if (flushRef.current === flush) flushRef.current = null;
            if (recoveryRef.current === recovery) recoveryRef.current = null;
        };
    }, [flushRef, recoveryRef, writable, instance]);
    return <section data-testid="session-editor" data-instance={instance} className="p-8">
        <label>session draft<input aria-label="session draft" value={draft} onChange={event => { if (writable.current) setDraft(event.target.value); }} /></label>
        <button type="button" onClick={() => probe.write()}>fixture write</button>
    </section>;
}

async function start() {
    if (!useCanvasStore.getState().hydrated) await new Promise<void>(resolve => {
        const unsubscribe = useCanvasStore.subscribe(state => { if (state.hydrated) { unsubscribe(); resolve(); } });
    });
    if (!await readCanvasProject(storageKey, projectId)) {
        const timestamp = new Date().toISOString();
        const project: CanvasProject = { id: projectId, title: "durable fixture graph", createdAt: timestamp, updatedAt: timestamp, nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
        await writeCanvasProjects(storageKey, new Map([[projectId, { base: null, value: project, conflictId: `seed-${projectId}`, savedAt: timestamp }]]));
    }
    useCanvasStore.subscribe((state, previous) => { if (state.projects !== previous.projects) probe.storeCommits++; });
    createRoot(document.getElementById("root")!).render(<StrictMode><MemoryRouter><main style={{ height: 700 }}>
        <CanvasEditorSession owner="test-session-owner" projectId={projectId}>{(flushRef, writable, recoveryRef) => <Editor flushRef={flushRef} writable={writable} recoveryRef={recoveryRef} />}</CanvasEditorSession>
    </main></MemoryRouter></StrictMode>);
}
void start().catch(error => { document.getElementById("root")!.textContent = String(error); });
