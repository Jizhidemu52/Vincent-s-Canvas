import { useSyncExternalStore } from "react";
import { useUserStore } from "@/stores/use-user-store";

type Preferences = { pinned: string[]; collapsed: string[] };
const empty: Preferences = { pinned: [], collapsed: ["image-tools"] };
const cache = new Map<string, Preferences>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function read(key: string): Preferences {
    if (cache.has(key)) return cache.get(key)!;
    let value = empty;
    try {
        const parsed = JSON.parse(localStorage.getItem(key) || "null");
        if (parsed && Array.isArray(parsed.pinned) && Array.isArray(parsed.collapsed)) value = {
            pinned: [...new Set<string>(parsed.pinned.filter((item: unknown) => typeof item === "string"))].slice(0, 12),
            collapsed: parsed.collapsed.filter((item: unknown) => typeof item === "string"),
        };
    } catch { /* A blocked setting store must not block navigation. */ }
    cache.set(key, value); return value;
}
/** Only tiny UI preferences; never stores usage records, prompts, or media. */
export function useNavigationPreferences() {
    const owner = useUserStore(state => state.user?.id || "trial");
    const key = `inchoice.navigation:${owner}`;
    const value = useSyncExternalStore(subscribe, () => read(key), () => empty);
    const toggle = (field: keyof Preferences, item: string) => {
        if ((useUserStore.getState().user?.id || "trial") !== owner) return;
        const previous = read(key);
        const next = { ...previous, [field]: previous[field].includes(item) ? previous[field].filter(entry => entry !== item) : [...previous[field], item].slice(0, 12) };
        cache.set(key, next);
        try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Keep the current tab preference. */ }
        listeners.forEach(listener => listener());
    };
    return { ...value, togglePin: (slug: string) => toggle("pinned", slug), toggleGroup: (group: string) => toggle("collapsed", group) };
}
