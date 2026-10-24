import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { setPromptFavorite, type PromptTemplate } from "@/services/api/prompts";
import { useUserStore } from "@/stores/use-user-store";

type PromptPage = { templates: PromptTemplate[]; total: number };
type ListState = { ownerId?: string; viewKey: string; items: PromptTemplate[]; total: number };
type Options = {
    ownerId?: string; viewKey: string; page: number; pageSize: number; favoriteOnly?: boolean; loading: boolean;
    setPage: Dispatch<SetStateAction<number>>;
    readPage: (page: number, pageSize: number) => Promise<PromptPage>;
    onRefreshError: (message: string) => void;
};

/** Serialize favorite writes without reloading the visible list or its review queue. */
export function createPromptFavoriteQueue() {
    let tail = Promise.resolve();
    const pending = new Map<string, Promise<void>>();
    return {
        run(id: string, action: () => Promise<void>) {
            const existing = pending.get(id);
            if (existing) return existing;
            const result = tail.catch(() => undefined).then(action);
            tail = result;
            pending.set(id, result);
            void result.then(() => pending.delete(id), () => pending.delete(id));
            return result;
        },
        async settled() {
            let observed: Promise<void>;
            do { observed = tail; await observed.catch(() => undefined); } while (observed !== tail);
        },
    };
}

export function usePromptFavoriteList(options: Options) {
    const [list, setList] = useState<ListState>({ viewKey: "", items: [], total: 0 });
    const listRef = useRef(list);
    listRef.current = list;
    const ownerScope = useMemo(() => ({ ownerId: options.ownerId, active: true, queue: createPromptFavoriteQueue() }), [options.ownerId]);
    const current = useRef({ options, ownerScope });
    current.current = { options, ownerScope };
    useEffect(() => {
        ownerScope.active = true;
        return () => { ownerScope.active = false; };
    }, [ownerScope]);
    const commit = useCallback((next: ListState) => { listRef.current = next; setList(next); }, []);
    const accept = useCallback((result: PromptPage) => {
        if (ownerScope.active && current.current.ownerScope === ownerScope && current.current.options.viewKey === options.viewKey
            && useUserStore.getState().user?.id === ownerScope.ownerId) {
            commit({ ownerId: ownerScope.ownerId, viewKey: options.viewKey, items: result.templates, total: result.total });
        }
    }, [commit, options.viewKey, ownerScope]);
    const waitForPending = useCallback(() => ownerScope.queue.settled(), [ownerScope]);
    const onFavorite = useCallback((item: PromptTemplate) => {
        const { options: view, ownerScope: origin } = current.current;
        const isCurrent = () => origin.active && current.current.ownerScope === origin
            && current.current.options.viewKey === view.viewKey && useUserStore.getState().user?.id === origin.ownerId;
        if (!isCurrent()) return Promise.resolve();
        if (view.loading || listRef.current.viewKey !== view.viewKey || listRef.current.ownerId !== origin.ownerId) {
            return Promise.reject(new Error("提示词列表正在更新，请稍后再试"));
        }
        return origin.queue.run(item.id, async () => {
            if (!isCurrent()) return;
            const existing = listRef.current.items.find(value => value.id === item.id);
            if (!existing) return;
            let favorite: boolean;
            try { ({ favorite } = await setPromptFavorite(item.id, !existing.favorite)); }
            catch (error) { if (isCurrent()) throw error; return; }
            if (!isCurrent()) return;
            const before = listRef.current;
            const remove = Boolean(view.favoriteOnly && !favorite && before.items.some(value => value.id === item.id));
            const next = { ...before,
                items: remove ? before.items.filter(value => value.id !== item.id) : before.items.map(value => value.id === item.id ? { ...value, favorite } : value),
                total: remove ? Math.max(0, before.total - 1) : before.total,
            };
            commit(next);
            if (!remove) return;
            const lastPage = Math.max(1, Math.ceil(next.total / view.pageSize));
            if (view.page > lastPage) { view.setPage(lastPage); return; }
            const expected = Math.min(view.pageSize, Math.max(0, next.total - (view.page - 1) * view.pageSize));
            if (next.items.length >= expected) return;
            try {
                // After removal the next row shifts into this page. Fetch only
                // that one offset, preserving the visible rows and list filters.
                const result = await view.readPage((view.page - 1) * view.pageSize + next.items.length + 1, 1);
                if (!isCurrent()) return;
                const items = [...listRef.current.items];
                const replacement = result.templates[0];
                if (replacement?.favorite && !items.some(value => value.id === replacement.id)) items.push(replacement);
                const remaining = Math.min(view.pageSize, Math.max(0, result.total - (view.page - 1) * view.pageSize));
                commit({ ...listRef.current, items: items.slice(0, remaining), total: result.total });
                const finalPage = Math.max(1, Math.ceil(result.total / view.pageSize));
                if (view.page > finalPage) view.setPage(finalPage);
                else if (items.length < remaining) view.onRefreshError("收藏状态已保存，但列表尚未补齐，请重新加载");
            } catch (error) {
                if (isCurrent()) view.onRefreshError(`收藏状态已保存，但补齐列表失败：${error instanceof Error ? error.message : "请重新加载"}`);
            }
        });
    }, [commit]);
    const visible = list.ownerId === options.ownerId ? list : { items: [], total: 0 };
    return { items: visible.items, total: visible.total, accept, waitForPending, onFavorite };
}
