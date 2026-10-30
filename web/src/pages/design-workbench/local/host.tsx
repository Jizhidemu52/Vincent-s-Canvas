import { uiText, useUiText } from "@/lib/i18n";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import { useUserStore } from "@/stores/use-user-store";
import { isModuleAvailable, useModuleEnabled, useModuleStore } from "@/stores/use-module-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { deploymentFeatures } from "@/lib/deployment-features";
import { createLocalWorkbenchServices, type LocalWorkbenchServices } from "./services";
import { setWorkbenchText } from "./ui-text.js";
import "./workbench.css";
import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { isWorkspaceRole } from "../../../../../shared/workspace-access";

const AssetPickerModal = lazy(() => import("@/components/canvas/asset-picker-modal").then((module) => ({ default: module.AssetPickerModal })));

type Mount = (root: HTMLElement, services: LocalWorkbenchServices) => (() => void) | Promise<() => void>;

export function LocalDesignWorkbench({ moduleKey, title, description, mount }: { moduleKey: "pattern-placement" | "pattern-repeat"; title: string; description: string; mount: Mount }) {
    useUiText();
    const host = useRef<HTMLDivElement>(null);
    const [dirty, setDirty] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [assetPickerError, setAssetPickerError] = useState("");
    const assetSelection = useRef<((asset: InsertAssetPayload | null) => void) | null>(null);
    useUnsavedGuard(dirty, uiText("有未保存更改。请等待自动保存，或返回工程重试保存/导出。"));
    const isManagementAccount = useUserStore((state) => state.status === "authenticated" && Boolean(state.user) && !isWorkspaceRole(state.user?.role));
    const ownerId = useUserStore((state) => ((state.status === "authenticated" || state.status === "expired") && state.user && isWorkspaceRole(state.user.role) ? state.user.id : null));
    const enabled = useModuleEnabled(moduleKey);
    const identityReady = !deploymentFeatures.authenticationEnabled || Boolean(ownerId);

    useEffect(() => {
        const root = host.current;
        if (!root || !enabled || !identityReady) return;
        const controller = new AbortController();
        setDirty(false);
        let cleanup: (() => void) | undefined;
        const dispose = () => {
            if (controller.signal.aborted) return;
            controller.abort();
            assetSelection.current?.(null);
            assetSelection.current = null;
            setAssetPickerOpen(false);
            cleanup?.();
            root.replaceChildren();
        };
        const unsubscribeUser = useUserStore.subscribe((state) => {
            if (deploymentFeatures.authenticationEnabled && (!(["authenticated", "expired"] as string[]).includes(state.status) || !isWorkspaceRole(state.user?.role) || state.user?.id !== ownerId)) dispose();
        });
        const checkModule = () => {
            if (!isModuleAvailable(useModuleStore.getState().flags, useBusinessConfigStore.getState().tools, moduleKey)) dispose();
        };
        const unsubscribeModules = useModuleStore.subscribe(checkModule);
        const unsubscribeConfig = useBusinessConfigStore.subscribe(checkModule);
        const services = createLocalWorkbenchServices(
            root,
            ownerId,
            controller.signal,
            setDirty,
            () =>
                new Promise((resolve) => {
                    assetSelection.current?.(null);
                    assetSelection.current = resolve;
                    setAssetPickerError("");
                    setAssetPickerOpen(true);
                }),
        );
        Promise.resolve(mount(root, services))
            .then((stop) => {
                if (controller.signal.aborted) stop();
                else cleanup = stop;
            })
            .catch((error) => {
                if (!controller.signal.aborted) {
                    const errorLabel = document.createElement("p");
                    root.replaceChildren(errorLabel);
                    setWorkbenchText(errorLabel, error instanceof Error ? error.message : "工作台加载失败，请重新进入");
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
                    <Link to="/creative">{uiText("← 创意工作台")}</Link>
                    <h1>{uiText(title || "")}</h1>
                    <p>{uiText(description || "")}</p>
                </div>
                <span className="badge">{uiText("本地编辑 · 无模型调用")}</span>
            </header>
            {assetPickerError && <p role="alert">{uiText(assetPickerError || "")}</p>}
            {assetPickerOpen && (
                <Suspense fallback={<p role="status">{uiText("正在打开素材库…")}</p>}>
                    <AssetPickerModal
                        open
                        onClose={() => {
                            assetSelection.current?.(null);
                            assetSelection.current = null;
                            setAssetPickerOpen(false);
                        }}
                        onInsert={(asset) => {
                            if (asset.kind !== "image") {
                                setAssetPickerError(uiText("工作台只能导入图片，请选择 PNG、JPG 或 WebP 素材。"));
                                return;
                            }
                            assetSelection.current?.(asset);
                            assetSelection.current = null;
                            setAssetPickerOpen(false);
                            setAssetPickerError("");
                        }}
                    />
                </Suspense>
            )}
            {!enabled ? (
                <p role="status">{uiText("该功能已由管理员关闭。")}</p>
            ) : !identityReady ? (
                <p role="status">{isManagementAccount ? uiText("当前工作台仅面向设计师账号，请使用员工设计师身份进入。") : uiText("请完成员工身份验证后使用工作台。")}</p>
            ) : (
                <div ref={host} className="local-workbench-host" />
            )}
        </main>
    );
}
