import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useUserStore } from "@/stores/use-user-store";
import { isModuleAvailable, useModuleEnabled, useModuleStore } from "@/stores/use-module-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { deploymentFeatures } from "@/lib/deployment-features";
import { createLocalWorkbenchServices, type LocalWorkbenchServices } from "./services";
import "./workbench.css";

type Mount = (root: HTMLElement, services: LocalWorkbenchServices) => (() => void) | Promise<() => void>;

export function LocalDesignWorkbench({ moduleKey, title, description, mount }: { moduleKey: "pattern-placement" | "pattern-repeat"; title: string; description: string; mount: Mount }) {
    const host = useRef<HTMLDivElement>(null);
    const ownerId = useUserStore((state) => state.status === "authenticated" && state.user?.role === "designer" ? state.user.id : null);
    const enabled = useModuleEnabled(moduleKey);
    const identityReady = !deploymentFeatures.authenticationEnabled || Boolean(ownerId);

    useEffect(() => {
        const root = host.current;
        if (!root || !enabled || !identityReady) return;
        const controller = new AbortController();
        let cleanup: (() => void) | undefined;
        const dispose = () => {
            if (controller.signal.aborted) return;
            controller.abort();
            cleanup?.();
            root.replaceChildren();
        };
        const unsubscribeUser = useUserStore.subscribe((state) => {
            if ((state.user?.id || null) !== ownerId) dispose();
        });
        const checkModule = () => {
            if (!isModuleAvailable(useModuleStore.getState().flags, useBusinessConfigStore.getState().tools, moduleKey)) dispose();
        };
        const unsubscribeModules = useModuleStore.subscribe(checkModule);
        const unsubscribeConfig = useBusinessConfigStore.subscribe(checkModule);
        const services = createLocalWorkbenchServices(root, ownerId, controller.signal);
        Promise.resolve(mount(root, services))
            .then((stop) => {
                if (controller.signal.aborted) stop();
                else cleanup = stop;
            })
            .catch((error) => {
                if (!controller.signal.aborted) {
                    root.textContent = error instanceof Error ? error.message : "工作台加载失败，请重新进入";
                }
            });
        return () => {
            unsubscribeUser();
            unsubscribeModules();
            unsubscribeConfig();
            dispose();
        };
    }, [enabled, identityReady, moduleKey, mount, ownerId]);

    return (
        <main className="local-design-workbench">
            <header className="local-workbench-heading">
                <div>
                    <Link to="/creative">← 创意工作台</Link>
                    <h1>{title}</h1>
                    <p>{description}</p>
                </div>
                <span className="badge">本地编辑 · 无模型调用</span>
            </header>
            {!enabled ? <p role="status">该功能已由管理员关闭。</p> : !identityReady ? <p role="status">请完成员工身份验证后使用工作台。</p> : <div ref={host} className="local-workbench-host" />}
        </main>
    );
}
