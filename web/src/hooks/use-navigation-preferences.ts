import { useSyncExternalStore } from "react";
import { useUserStore } from "@/stores/use-user-store";

type Preferences = { pinned: string[]; collapsed: string[]; recent: string[] };
const empty: Preferences = { pinned: [], collapsed: ["image-tools"], recent: [] };
const preferenceLimit = 64;
const cache = new Map<string, Preferences>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function read(key: string): Preferences {
    if (cache.has(key)) return cache.get(key)!;
    let value = empty;
    try {
        const parsed = JSON.parse(localStorage.getItem(key) || "null");
        if (parsed && Array.isArray(parsed.pinned) && Array.isArray(parsed.collapsed)) value = {
            pinned: [...new Set<string>(parsed.pinned.filter((item: unknown) => typeof item === "string"))].slice(0, preferenceLimit),
            collapsed: parsed.collapsed.filter((item: unknown) => typeof item === "string"),
            recent: Array.isArray(parsed.recent) ? [...new Set<string>(parsed.recent.filter((item: unknown) => typeof item === "string"))].slice(0, 12) : [],
        };
    } catch { /* A blocked setting store must not block navigation. */ }
    cache.set(key, value); return value;
}
/** Only tiny UI preferences; never stores usage records, prompts, or media. */
export function useNavigationPreferences() {
    const owner = useUserStore(state => state.user?.id || "trial");
    const key = `inchoice.navigation:${owner}`;
    const value = useSyncExternalStore(subscribe, () => read(key), () => empty);
    const save = (next: Preferences) => {
        cache.set(key, next);
        try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Keep the current tab preference. */ }
        listeners.forEach(listener => listener());
    };
    const toggle = (field: "pinned" | "collapsed", item: string) => {
        if ((useUserStore.getState().user?.id || "trial") !== owner) return;
        const previous = read(key);
        const next = { ...previous, [field]: previous[field].includes(item) ? previous[field].filter(entry => entry !== item) : [...previous[field], item].slice(0, preferenceLimit) };
        save(next);
    };
    return { ...value, togglePin: (slug: string) => toggle("pinned", slug), toggleGroup: (group: string) => toggle("collapsed", group),
        recordRecent: (board: string) => {
            if ((useUserStore.getState().user?.id || "trial") !== owner || read(key).recent[0] === board) return;
            const previous = read(key);
            save({ ...previous, recent: [board, ...previous.recent.filter(item => item !== board)].slice(0, 12) });
        },
        openGroup: (group: string) => { if (read(key).collapsed.includes(group)) toggle("collapsed", group); } };
}
