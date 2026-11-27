import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasCloudRequestError, CanvasRevisionConflict, type CloudCanvasAcknowledgement, type CloudCanvasDocument, type CloudCanvasSummary } from "@/services/api/canvas-documents";
import { encodeCanvasProject, parseCanvasProject, serializeCanvasProject } from "./canvas-project-codec";
import { mapCanvasAsyncPool } from "./canvas-async-pool";

type CopyPlan = { key: string; id: string; savedAt: string };
type BaselineEntry = {
    revision: number; local: string | null;
    pendingDelete?: boolean;
    redirect?: string; redirectRevision?: number;
    pendingCopy?: CopyPlan;
};
export type CanvasCloudBaseline = Record<string, BaselineEntry>;
type Dependencies = {
    list: () => Promise<CloudCanvasSummary[]>;
    get: (id: string) => Promise<CloudCanvasDocument>;
    put: (id: string, revision: number, document: CanvasProject | null) => Promise<CloudCanvasAcknowledgement>;
    portable: (project: CanvasProject, rejected?: ReadonlySet<string>) => Promise<CanvasProject>;
    saveBaseline: (value: CanvasCloudBaseline) => Promise<void>;
    newId: () => string;
    onCopy: (copy: CanvasProject) => Promise<void>;
};
export function canvasCloudDocument(project: CanvasProject): CanvasProject {
    const { history: _history, selectedNodeIds: _selection, ...content } = project;
    return { ...content, viewport: { x: 0, y: 0, k: 1 } };
}
function mediaReferences(value: unknown, refs: Set<string>, field = "") {
    if (Array.isArray(value)) { for (const item of value) mediaReferences(item, refs, field); return; }
    if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) mediaReferences(child, refs, key);
    } else if (typeof value === "string") {
        if (field === "assetId" || field === "serverAssetId" || field === "storageKey" || field === "imageOptions") refs.add(value);
        else if (field === "references" && /^(image|video|audio|file|media):/.test(value)) refs.add(value);
        else {
            const id = value.match(/^\/api\/assets\/([a-f0-9-]{36})\/content\/?$/i)?.[1];
            if (id) refs.add(id.toLowerCase());
        }
    }
}
export function canvasMediaSignature(project: CanvasProject | null) {
    const refs = new Set<string>();
    if (project) mediaReferences(canvasCloudDocument(project), refs);
    return JSON.stringify([...refs].sort());
}
function rejectedMediaError(project: CanvasProject, error: CanvasCloudRequestError) {
    const labels = project.nodes.filter(node => {
        const refs = new Set<string>();
        mediaReferences(node.metadata, refs);
        return error.rejectedAssetIds.some(id => refs.has(id));
    }).map(node => node.title || node.id);
    const location = labels.length ? `节点「${[...new Set(labels)].slice(0, 3).join("」、「")}」` : "画布引用";
    const hint = error.rejectedAssetIds.length ? `（素材 ${error.rejectedAssetIds.slice(0, 3).map(id => id.slice(0, 8)).join("、")}）` : "";
    return new CanvasCloudRequestError(`${location}有无法访问的素材${hint}。请保留本机草稿，重新选择原图或恢复素材访问权限后重试。`, error.status, error.code, error.rejectedAssetIds);
}
const snapshot = (project: CanvasProject | null) => project ? serializeCanvasProject(canvasCloudDocument(project)) : null;
export class CanvasCloudBatchError extends Error {
    constructor(public failures: Array<{ id: string; error: unknown }>) {
        super(failures.map(({ id, error }) => `${id}: ${error instanceof Error ? error.message : "同步失败"}`).join("；"));
    }
}
// PostgreSQL jsonb does not retain object-key order. Equality must not create
// conflict copies merely because a successful response was lost or reordered.
const canonical = (value: unknown) => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
    ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : child);
const sameDocument = (a: CanvasProject | null, b: CanvasProject | null) => snapshot(a) === snapshot(b);

/** A per-owner CAS synchronizer. Callers serialize saves and durably store hydrate's result before saving. */
export function createCanvasCloudSync(baseline: CanvasCloudBaseline, io: Dependencies) {
    Object.setPrototypeOf(baseline, null);
    for (const entry of Object.values(baseline)) if (entry.local) entry.local = snapshot(parseCanvasProject(entry.local));
    const hydrated = new Map<string, BaselineEntry>();
    const deferred = new Map<string, CloudCanvasSummary>();
    let hydrationCheckpointPending = false;
    const checkpoint = async () => { await io.saveBaseline(structuredClone(baseline)); hydrationCheckpointPending = false; };
    function acceptHydrated(current: ReadonlyMap<string, CanvasProject>) {
        let accepted = false;
        for (const [id, entry] of hydrated) {
            if (snapshot(current.get(id) || null) === entry.local) {
                baseline[id] = entry;
                hydrated.delete(id);
                deferred.delete(id);
                accepted = true;
            }
        }
        if (accepted) hydrationCheckpointPending = true;
        return accepted;
    }
    async function stageCachedDocument(local: CanvasProject, remote: CloudCanvasDocument) {
        if (baseline[local.id] || !remote.document) return;
        // Another tab can make a deferred document durable before this tab opens
        // it. Adopt its revision only after proving the complete content matches;
        // local Blob/cache fields alone are not a competing edit.
        if (sameDocument(local, remote.document) || sameDocument(await io.portable(canvasCloudDocument(structuredClone(local))), remote.document)) {
            hydrated.set(local.id, { revision: remote.revision, local: snapshot(local) });
        }
    }
    function copyOf(project: CanvasProject, plan: CopyPlan) {
        return { ...canvasCloudDocument(project), id: plan.id, title: `${project.title}（云端冲突副本）`, persistenceConflict: { projectId: project.id, paths: ["$cloudRevision"], savedAt: plan.savedAt } };
    }
    return {
        synchronizedProjectIds: (projects: CanvasProject[]) => projects.filter(project => {
            const entry = baseline[project.id];
            return entry && !entry.redirect && !entry.pendingDelete && entry.local === snapshot(project);
        }).map(project => project.id),
        pendingDeleteIds: () => Object.keys(baseline).filter(id => baseline[id].pendingDelete),
        hasSavedImageTask(projectId: string, nodeId: string, requestId: string, ownerId: string) {
            const entry = baseline[projectId];
            if (!entry?.revision || !entry.local || entry.pendingDelete || entry.redirect) return false;
            const task = parseCanvasProject(entry.local).nodes.find(node => node.id === nodeId)?.metadata?.imageTask;
            return task?.ownerId === ownerId && task.projectId === projectId && task.requestId === requestId;
        },
        async hydrate(local: CanvasProject[], options: { live?: boolean; deferUncached?: boolean } = {}) {
            const documents = await io.list();
            const projects = new Map(local.map(project => [project.id, project]));
            deferred.clear();
            await mapCanvasAsyncPool(documents, 4, async remote => {
                const ours = projects.get(remote.id);
                const known = baseline[remote.id];
                const clean = known && snapshot(ours || null) === known.local;
                if (ours && !known && !remote.deleted) {
                    await stageCachedDocument(ours, await io.get(remote.id));
                    return;
                }
                if (!ours && known?.pendingDelete) return;
                if (!ours && !remote.deleted && options.deferUncached) {
                    deferred.set(remote.id, remote);
                    return;
                }
                if (!ours || (!options.live && clean)) {
                    // An unchanged server revision must not discard IndexedDB media caches.
                    if (ours && clean && remote.revision === known.revision && !remote.deleted) return;
                    const full = remote.deleted ? { ...remote, document: null } : await io.get(remote.id);
                    if (full.document) projects.set(remote.id, full.document);
                    else projects.delete(remote.id);
                    hydrated.set(remote.id, { revision: full.revision, local: snapshot(full.document) });
                }
            });
            // Do not persist the new baseline before the caller has stored these documents.
            return [...projects.values()];
        },
        deferredProjects: () => [...deferred.values()].flatMap(item => item.summary ? [item.summary] : []),
        async load(id: string, cached?: CanvasProject): Promise<CanvasProject | null> {
            const remote = await io.get(id);
            if (cached) {
                await stageCachedDocument(cached, remote);
                // Unconfirmed local edits must never be replaced merely by
                // opening their summary. CAS will preserve a real conflict.
                return cached;
            }
            hydrated.set(id, { revision: remote.revision, local: snapshot(remote.document) });
            return remote.document;
        },
        async refreshCached(project: CanvasProject) {
            const remote = await io.get(project.id);
            if (!remote.document) return project;
            const entry = baseline[project.id];
            if (entry && !entry.redirect && !entry.pendingDelete && remote.revision > entry.revision && entry.local === snapshot(project)) {
                const latest = { ...remote.document, viewport: project.viewport, selectedNodeIds: project.selectedNodeIds };
                hydrated.set(project.id, { revision: remote.revision, local: snapshot(latest) });
                return latest;
            }
            if (sameDocument(project, remote.document) || sameDocument(await io.portable(canvasCloudDocument(structuredClone(project))), remote.document)) {
                baseline[project.id] = { revision: remote.revision, local: snapshot(project) };
                await checkpoint();
            }
            return project;
        },
        async confirmHydrated(projects: CanvasProject[]): Promise<void> {
            // Call after durable local storage, before exposing hydrated projects to
            // editors that can immediately change updatedAt, history or media caches.
            const current = new Map(projects.map(project => [project.id, project]));
            acceptHydrated(current);
            for (const id of current.keys()) deferred.delete(id);
            // A failed checkpoint after the document itself was committed must
            // be retried even when the next load finds that local document.
            if (hydrationCheckpointPending) await checkpoint();
        },
        async save(projects: CanvasProject[], changedIds?: Iterable<string>, skippedIds: ReadonlySet<string> = new Set()) {
            // All dirty decisions use the batch's initial baseline, not changes made
            // by onCopy. Otherwise a stale clean recovery copy can overwrite a newer edit.
            const current = new Map(structuredClone(projects).map(project => [project.id, project]));
            // A failed IndexedDB hydration must not advance the revision of old local
            // data or turn a document that was never stored into a cloud deletion.
            acceptHydrated(current);
            const initial = structuredClone(baseline);
            Object.setPrototypeOf(initial, null);
            const ids = new Set(changedIds ?? current.keys());
            if (!changedIds) for (const [id, entry] of Object.entries(initial)) if (entry.pendingDelete) ids.add(id);
            const failures: Array<{ id: string; error: unknown }> = [];

            async function preserveCopy(ownerId: string, source: CanvasProject, cloudSource: CanvasProject, revision: number, kind: "remote" | "recovery") {
                // HTTP LAN origins may not expose WebCrypto. Keep an exact canonical key.
                const key = canonical([kind, revision, encodeCanvasProject(cloudSource)]);
                let plan = baseline[ownerId]?.pendingCopy;
                if (plan?.key !== key) {
                    plan = { key, id: io.newId(), savedAt: new Date().toISOString() };
                    baseline[ownerId] = { ...(baseline[ownerId] || { revision: 0, local: null }), pendingCopy: plan };
                    // Journal before any external write: retries after a crash reuse the same copy.
                    await checkpoint();
                }
                const copy = copyOf(source, plan);
                const portableCopy = copyOf(cloudSource, plan);
                let saved: CloudCanvasAcknowledgement;
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
                const source = local ? canvasCloudDocument(structuredClone(local)) : null;
                let portable = source ? await io.portable(source) : null;
                async function submit(baseRevision: number) {
                    try { return await io.put(id, baseRevision, portable); }
                    catch (error) {
                        if (!(error instanceof CanvasCloudRequestError) || error.code !== "CANVAS_ASSET_FORBIDDEN" || !source || !portable) throw error;
                        if (error.rejectedAssetIds.length) {
                            const repaired = await io.portable(source, new Set(error.rejectedAssetIds));
                            if (!sameDocument(repaired, portable)) {
                                portable = repaired;
                                try { return await io.put(id, baseRevision, repaired); }
                                catch (second) {
                                    if (second instanceof CanvasCloudRequestError && second.code === "CANVAS_ASSET_FORBIDDEN") throw rejectedMediaError(repaired, second);
                                    throw second;
                                }
                            }
                        }
                        throw rejectedMediaError(portable, error);
                    }
                }
                let saved: CloudCanvasAcknowledgement;
                try { saved = await submit(revision); }
                catch (error) {
                    if (!(error instanceof CanvasRevisionConflict)) throw error;
                    const remote = error.current;
                    if (sameDocument(remote.document, portable)) saved = remote;
                    else if (remote.document) {
                        await preserveCopy(id, remote.document, remote.document, remote.revision, "remote");
                        saved = await submit(remote.revision);
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
                if (skippedIds.has(id)) continue;
                try {
                const local = current.get(id) || null;
                const encoded = snapshot(local);
                const entry = initial[id];
                if (local && entry?.pendingDelete) delete baseline[id].pendingDelete;
                if (!local && entry?.local && !entry.pendingDelete) {
                    baseline[id].pendingDelete = true;
                    await checkpoint();
                }
                if (entry?.local === encoded) continue;
                if (entry?.redirect && local) {
                    const targetId = entry.redirect;
                    const previous = initial[targetId]?.local;
                    const previousCopy = previous ? parseCanvasProject(previous) : undefined;
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
                } catch (error) { failures.push({ id, error }); }
            }
            await checkpoint();
            if (failures.length) throw new CanvasCloudBatchError(failures);
        },
    };
}
