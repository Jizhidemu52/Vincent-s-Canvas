import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { uiText } from "@/lib/i18n";
import { useUserStore } from "@/stores/use-user-store";

/** A durable, account-partitioned field. A delayed read must never replace newer input. */
export function useGenerationDraft<T>(key: string, initial: T, hydrate?: (value: T) => Promise<T>): [T, Dispatch<SetStateAction<T>>, boolean] {
    const ownerId = useUserStore(state => state.user?.id);
    const status = useUserStore(state => state.status);
    const storage = useMemo(() => createWorkspaceStorage("generation_drafts"), [ownerId, status]);
    // Initial values belong to this field/employee, not to whichever draft was mounted before it.
    const scope = useMemo(() => ({ ownerId, key, initial }), [ownerId, key]);
    const empty = { scope, value: scope.initial, ready: false, changed: false };
    const [draft, setDraft] = useState(empty);
    const current = draft.scope === scope ? draft : empty;
    const queue = useRef(Promise.resolve());
    const hydrateRef = useRef(hydrate);
    const { message } = App.useApp();
    hydrateRef.current = hydrate;
    const update = useCallback<Dispatch<SetStateAction<T>>>(next => {
        setDraft(previous => {
            const field = previous.scope === scope ? previous : { scope, value: scope.initial, ready: false, changed: false };
            return { ...field, value: typeof next === "function" ? (next as (value: T) => T)(field.value) : next, changed: true };
        });
    }, [scope]);
    useEffect(() => {
        if (!storage.isCurrent()) return;
        let active = true;
        void storage.getItem<T>(key).then(async saved => {
            const restored = saved !== null && hydrateRef.current ? await hydrateRef.current(saved) : saved;
            if (active) setDraft(previous => {
                const field = previous.scope === scope ? previous : { scope, value: scope.initial, ready: false, changed: false };
                return !field.changed && restored !== null ? { ...field, value: restored } : field;
            });
        }).catch(() => { if (active && storage.isCurrent()) message.warning(uiText("草稿暂时无法恢复，请检查浏览器存储。")); })
            .finally(() => {
                if (active) setDraft(previous => ({ ...(previous.scope === scope ? previous : { scope, value: scope.initial, changed: false }), ready: true }));
            });
        return () => { active = false; };
    }, [key, scope, storage, message]);
    useEffect(() => {
        if (!current.ready || !current.changed || !storage.isCurrent()) return;
        let active = true;
        queue.current = queue.current.catch(() => undefined).then(async () => {
            if (!storage.isCurrent()) return;
            await storage.setItem(key, current.value);
        }).catch(() => { if (active && storage.isCurrent()) message.warning({ key: "draft-save-failed", content: uiText("草稿保存失败，请先复制输入再离开页面。") }); });
        // Do not cancel an authorized queued write on navigation; only suppress stale UI feedback.
        return () => { active = false; };
    }, [key, current.value, current.ready, current.changed, storage, message]);
    return [current.value, update, current.ready];
}
