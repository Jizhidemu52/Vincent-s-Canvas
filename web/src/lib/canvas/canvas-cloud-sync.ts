import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasRevisionConflict, type CloudCanvasDocument } from "@/services/api/canvas-documents";

type CopyPlan = { key: string; id: string; savedAt: string };
type BaselineEntry = {
    revision: number; local: string | null;
    redirect?: string; redirectRevision?: number;
    pendingCopy?: CopyPlan;
};
export type CanvasCloudBaseline = Record<string, BaselineEntry>;
type Dependencies = {
    list: () => Promise<CloudCanvasDocument[]>;
    put: (id: string, revision: number, document: CanvasProject | null) => Promise<CloudCanvasDocument>;
    portable: (project: CanvasProject) => Promise<CanvasProject>;
    saveBaseline: (value: CanvasCloudBaseline) => Promise<void>;
    newId: () => string;
    onCopy: (copy: CanvasProject) => Promise<void>;
};
const snapshot = (project: CanvasProject | null) => project ? JSON.stringify(project) : null;
// PostgreSQL jsonb does not retain object-key order. Equality must not create
// conflict copies merely because a successful response was lost or reordered.
const canonical = (value: unknown) => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
    ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : child);
const sameDocument = (a: CanvasProject | null, b: CanvasProject | null) => canonical(a) === canonical(b);

/** A per-owner CAS synchronizer. Callers serialize saves and durably store hydrate's result before saving. */
export function createCanvasCloudSync(baseline: CanvasCloudBaseline, io: Dependencies) {
    Object.setPrototypeOf(baseline, null);
    const hydrated = new Map<string, BaselineEntry>();
    const checkpoint = () => io.saveBaseline(structuredClone(baseline));
    function acceptHydrated(current: ReadonlyMap<string, CanvasProject>) {
        let accepted = false;
        for (const [id, entry] of hydrated) {
            if (snapshot(current.get(id) || null) === entry.local) {
                baseline[id] = entry;
                hydrated.delete(id);
                accepted = true;
            }
        }
        return accepted;
    }
    function copyOf(project: CanvasProject, plan: CopyPlan) {
        return { ...project, id: plan.id, title: `${project.title}（云端冲突副本）`, persistenceConflict: { projectId: project.id, paths: ["$cloudRevision"], savedAt: plan.savedAt } };
    }
    return {
        async hydrate(local: CanvasProject[], options: { live?: boolean } = {}) {
            const documents = await io.list();
            const projects = new Map(local.map(project => [project.id, project]));
            for (const remote of documents) {
                const ours = projects.get(remote.id);
                const known = baseline[remote.id];
                const clean = known && snapshot(ours || null) === known.local;
                if ((!ours && !known) || (!options.live && clean)) {
                    // An unchanged server revision must not discard IndexedDB media caches.
                    if (clean && remote.revision === known.revision && remote.document) continue;
                    if (remote.document) projects.set(remote.id, remote.document);
                    else projects.delete(remote.id);
                    hydrated.set(remote.id, { revision: remote.revision, local: snapshot(remote.document) });
                }
            }
            // Do not persist the new baseline before the caller has stored these documents.
            return [...projects.values()];
        },
        async confirmHydrated(projects: CanvasProject[]): Promise<void> {
            // Call after durable local storage, before exposing hydrated projects to
            // editors that can immediately change updatedAt, history or media caches.
            if (acceptHydrated(new Map(projects.map(project => [project.id, project])))) await checkpoint();
        },
        async save(projects: CanvasProject[]) {
            // All dirty decisions use the batch's initial baseline, not changes made
            // by onCopy. Otherwise a stale clean recovery copy can overwrite a newer edit.
            const current = new Map(structuredClone(projects).map(project => [project.id, project]));
            // A failed IndexedDB hydration must not advance the revision of old local
            // data or turn a document that was never stored into a cloud deletion.
            acceptHydrated(current);
            const initial = structuredClone(baseline);
            Object.setPrototypeOf(initial, null);
            const ids = new Set([...current.keys(), ...Object.keys(initial)]);

            async function preserveCopy(ownerId: string, source: CanvasProject, cloudSource: CanvasProject, revision: number, kind: "remote" | "recovery") {
                // HTTP LAN origins may not expose WebCrypto. Keep an exact canonical key.
                const key = canonical([kind, revision, cloudSource]);
                let plan = baseline[ownerId]?.pendingCopy;
                if (plan?.key !== key) {
                    plan = { key, id: io.newId(), savedAt: new Date().toISOString() };
                    baseline[ownerId] = { ...(baseline[ownerId] || { revision: 0, local: null }), pendingCopy: plan };
                    // Journal before any external write: retries after a crash reuse the same copy.
                    await checkpoint();
                }
                const copy = copyOf(source, plan);
                const portableCopy = copyOf(cloudSource, plan);
                let saved: CloudCanvasDocument;
                try { saved = await io.put(copy.id, 0, portableCopy); }
                catch (error) {
                    if (!(error instanceof CanvasRevisionConflict)) throw error;
                    if (!sameDocument(error.current.document, portableCopy)) {
                        // The user may have edited an earlier backup. Never overwrite it.
                        baseline[ownerId].pendingCopy = { ...plan, id: io.newId() };
                        await checkpoint();
                        throw error;
                    }
                    saved = error.current;
                }
                const localCopy = current.get(copy.id);
                const locallyEdited = initial[copy.id]
                    ? snapshot(localCopy || null) !== initial[copy.id].local
                    : localCopy && snapshot(localCopy) !== snapshot(copy);
                if (!locallyEdited) await io.onCopy(structuredClone(copy));
                baseline[copy.id] = { revision: saved.revision, local: snapshot(copy) };
                await checkpoint();
                return { copy, revision: saved.revision };
            }

            async function write(id: string, local: CanvasProject | null, revision: number) {
                const encoded = snapshot(local);
                const portable = local ? await io.portable(structuredClone(local)) : null;
                let saved: CloudCanvasDocument;
                try { saved = await io.put(id, revision, portable); }
                catch (error) {
                    if (!(error instanceof CanvasRevisionConflict)) throw error;
                    const remote = error.current;
                    if (sameDocument(remote.document, portable)) saved = remote;
                    else if (remote.document) {
                        await preserveCopy(id, remote.document, remote.document, remote.revision, "remote");
                        saved = await io.put(id, remote.revision, portable);
                    } else if (local) {
                        const recovery = await preserveCopy(id, local, portable!, remote.revision, "recovery");
                        baseline[id] = { revision: remote.revision, local: encoded, redirect: recovery.copy.id, redirectRevision: recovery.revision };
                        hydrated.delete(id);
                        return { id: recovery.copy.id, revision: recovery.revision, document: recovery.copy };
                    } else saved = remote;
                }
                baseline[id] = { revision: saved.revision, local: encoded };
                hydrated.delete(id);
                return { id, revision: saved.revision, document: local };
            }

            for (const id of ids) {
                const local = current.get(id) || null;
                const encoded = snapshot(local);
                const entry = initial[id];
                if (entry?.local === encoded) continue;
                if (entry?.redirect && local) {
                    const targetId = entry.redirect;
                    const previous = initial[targetId]?.local;
                    const previousCopy = previous ? JSON.parse(previous) as CanvasProject : undefined;
                    const copy = { ...local, id: targetId, title: `${local.title}（云端冲突副本）`, persistenceConflict: previousCopy?.persistenceConflict || local.persistenceConflict };
                    const saved = await write(targetId, copy, entry.redirectRevision ?? initial[targetId]?.revision ?? 0);
                    const targetWasEdited = snapshot(current.get(targetId) || null) !== (initial[targetId]?.local ?? null);
                    if (!targetWasEdited && saved.id === targetId) await io.onCopy(structuredClone(saved.document!));
                    if (saved.id !== targetId) {
                        // This batch's target snapshot was not the outgoing alias edit.
                        // Keep it clean/dirty against its own baseline, not the alias payload.
                        baseline[targetId] = { revision: baseline[targetId].revision, local: initial[targetId]?.local ?? null };
                    }
                    baseline[id] = { revision: entry.revision, local: encoded, redirect: saved.id, redirectRevision: saved.revision };
                } else await write(id, local, entry?.revision || 0);
                hydrated.delete(id);
                await checkpoint();
            }
            await checkpoint();
        },
    };
}
