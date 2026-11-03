import { createStore } from "zustand/vanilla";
import type { PublicReleaseNote, ReleaseNotesPage } from "../../../shared/release-notes";

type Seen = { readVersion?: string; notifiedVersion?: string };
type Dependencies = {
    list: (offset: number, signal: AbortSignal) => Promise<ReleaseNotesPage<PublicReleaseNote>>;
    readSeen: (ownerId: string) => Promise<Seen | null>;
    writeSeen: (ownerId: string, seen: Seen) => Promise<unknown>;
    isCurrentOwner: (ownerId: string) => boolean;
    isVisible?: () => boolean;
    now?: () => number;
};

export const releaseNoteSummary = (content: string) => {
    const text = content.replace(/\s+/g, " ").trim();
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};
export const releaseVersion = (value: string) => `v${value.trim().replace(/^v/, "")}`;

type State = {
    ownerId: string | null; notes: PublicReleaseNote[]; hasMore: boolean; loading: boolean; error: string; supported: boolean;
    open: boolean; selectedVersion: string | null; seen: Seen; ready: boolean;
    setOwner: (ownerId: string | null) => Promise<void>;
    refresh: (force?: boolean, more?: boolean) => Promise<void>;
    show: (version?: string) => void; close: () => void;
    claimNotice: () => PublicReleaseNote | null;
};

/** One shared read-only observer. Each async boundary is scoped to a verified employee identity. */
export function createReleaseNotesStore(deps: Dependencies) {
    let epoch = 0, pending: AbortController | null = null, lastFetch = 0;
    const now = deps.now || Date.now;
    const current = (ownerId: string, captured: number) => epoch === captured && deps.isCurrentOwner(ownerId);
    return createStore<State>((set, get) => {
        const saveSeen = (ownerId: string, seen: Seen) => { void deps.writeSeen(ownerId, seen).catch(() => undefined); };
        const markRead = (version: string) => {
            const state = get();
            if (!state.ownerId || !deps.isCurrentOwner(state.ownerId)) return;
            // Reading an older release must not turn the latest release back into an unread one.
            const seen = state.notes[0]?.version === version ? { readVersion: version, notifiedVersion: version } : state.seen;
            set({ seen }); saveSeen(state.ownerId, seen);
        };
        return {
            ownerId: null, notes: [], hasMore: false, loading: false, error: "", supported: true, open: false, selectedVersion: null, seen: {}, ready: false,
            async setOwner(ownerId) {
                if (ownerId === get().ownerId) return;
                const captured = ++epoch;
                pending?.abort(); pending = null; lastFetch = 0;
                set({ ownerId, notes: [], hasMore: false, loading: false, error: "", supported: true, open: false, selectedVersion: null, seen: {}, ready: false });
                if (!ownerId) return;
                const seen = await deps.readSeen(ownerId).catch(() => null);
                if (!current(ownerId, captured)) return;
                set({ seen: seen || {}, ready: true });
                await get().refresh(true);
            },
            async refresh(force = false, more = false) {
                const state = get(), ownerId = state.ownerId, captured = epoch;
                if (!ownerId || !state.ready || !state.supported || pending || !current(ownerId, captured) || deps.isVisible?.() === false) return;
                if (!force && !more && lastFetch && now() - lastFetch < 60_000) return;
                const controller = new AbortController(); pending = controller;
                set({ loading: true, error: "" });
                lastFetch = now();
                try {
                    const page = await deps.list(more ? state.notes.length : 0, controller.signal);
                    if (!current(ownerId, captured) || controller.signal.aborted) return;
                    const notes = more ? [...state.notes, ...page.notes.filter(note => !state.notes.some(old => old.version === note.version))] : page.notes;
                    set({ notes, hasMore: page.hasMore });
                    if (get().open && (!get().selectedVersion || !notes.some(note => note.version === get().selectedVersion))) set({ selectedVersion: notes[0]?.version || null });
                    if (get().open && get().selectedVersion) markRead(get().selectedVersion!);
                } catch (error) {
                    if (!current(ownerId, captured) || controller.signal.aborted) return;
                    const status = (error as { status?: number }).status;
                    set({ error: "版本更新暂时无法读取，不影响继续创作。", ...(status === 404 || status === 405 ? { supported: false, notes: [], open: false } : {}) });
                } finally {
                    if (pending === controller) pending = null;
                    if (current(ownerId, captured)) set({ loading: false });
                }
            },
            show(version) {
                const state = get();
                if (!state.ownerId || !state.supported || !deps.isCurrentOwner(state.ownerId)) return;
                const selectedVersion = version || state.notes[0]?.version || null;
                set({ open: true, selectedVersion });
                if (selectedVersion) markRead(selectedVersion);
                void get().refresh();
            },
            close: () => set({ open: false }),
            claimNotice() {
                const state = get(), latest = state.notes[0];
                if (!state.ownerId || !latest || !deps.isCurrentOwner(state.ownerId) || state.open || state.seen.readVersion === latest.version || state.seen.notifiedVersion === latest.version) return null;
                const seen = { ...state.seen, notifiedVersion: latest.version };
                set({ seen }); saveSeen(state.ownerId, seen);
                return latest;
            },
        };
    });
}
