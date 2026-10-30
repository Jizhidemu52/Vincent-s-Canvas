import { App } from "antd";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useBlocker } from "react-router-dom";
import { uiText } from "@/lib/i18n";

const drafts = new Map<symbol, string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => drafts.size;

/** Registers a draft; navigation protection is mounted once inside the router layout. */
export function useUnsavedGuard(dirty: boolean, description = "当前内容尚未保存，离开后本次修改可能丢失。") {
    const { modal } = App.useApp();
    const id = useRef(Symbol("unsaved-draft"));
    useEffect(() => {
        if (dirty) drafts.set(id.current, description);
        else drafts.delete(id.current);
        notify();
        return () => { drafts.delete(id.current); notify(); };
    }, [dirty, description]);
    const confirmDiscard = useCallback(async () => !dirty || Boolean(await modal.confirm({
        title: uiText("放弃未保存的修改？"), content: uiText(description),
        okText: uiText("放弃修改"), cancelText: uiText("继续编辑"), okButtonProps: { danger: true },
    })), [dirty, description, modal]);
    return { confirmDiscard };
}

/** Use for local tab changes that do not update the URL. */
export function useConfirmUnsavedChanges() {
    const { modal } = App.useApp();
    return useCallback(async () => !drafts.size || Boolean(await modal.confirm({
        title: uiText("放弃未保存的修改？"), content: [...new Set(drafts.values())].map(value => uiText(value)).join("\n"),
        okText: uiText("放弃修改"), cancelText: uiText("继续编辑"), okButtonProps: { danger: true },
    })), [modal]);
}

/** React Router supports one navigation blocker, shared by all registered forms. */
export function useUnsavedNavigationGuard() {
    const count = useSyncExternalStore(subscribe, snapshot, () => 0);
    const confirmDiscard = useConfirmUnsavedChanges();
    const blocker = useBlocker(({ currentLocation, nextLocation }) => count > 0
        && `${currentLocation.pathname}${currentLocation.search}` !== `${nextLocation.pathname}${nextLocation.search}`);
    const confirming = useRef(false);
    useEffect(() => {
        if (blocker.state !== "blocked" || confirming.current) return;
        confirming.current = true;
        void confirmDiscard().then((confirmed) => {
            if (confirmed) blocker.proceed(); else blocker.reset();
        }).finally(() => { confirming.current = false; });
    }, [blocker, confirmDiscard]);
    useEffect(() => {
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (!drafts.size) return;
            event.preventDefault(); event.returnValue = "";
        };
        window.addEventListener("beforeunload", beforeUnload);
        return () => window.removeEventListener("beforeunload", beforeUnload);
    }, []);
}
