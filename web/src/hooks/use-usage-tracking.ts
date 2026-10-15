import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { deploymentFeatures } from "@/lib/deployment-features";
import { classifyUsageElement, usageCommand, usageElement, usageParameters, usagePrivate } from "@/lib/usage-event-policy";
import { usageBoardAvailable, usageBoardForLocation } from "@/lib/usage-navigation";
import { useUserStore } from "@/stores/use-user-store";
import { useModuleStore } from "@/stores/use-module-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { flushUsage, recordUsage, setUsageOwner } from "@/stores/use-usage-store";
import type { UsageAction, UsageControlKey, UsageParameters } from "../../../shared/usage-analytics";

export function useUsageTracking() {
    const location = useLocation();
    const user = useUserStore(state => state.user), status = useUserStore(state => state.status);
    const flags = useModuleStore(state => state.flags), moduleStatus = useModuleStore(state => state.status);
    const tools = useBusinessConfigStore(state => state.tools);
    const owner = status === "authenticated" && user?.status === "active" ? user.id : null;
    const board = usageBoardForLocation(location.pathname, location.search);
    const allowed = Boolean(owner && moduleStatus === "ready" && usageBoardAvailable(board, flags, tools));
    useEffect(() => { setUsageOwner(owner, deploymentFeatures.oaLoginEnabled); }, [owner]);
    useEffect(() => {
        if (!allowed || !owner || !board) return;
        recordUsage({ eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), boardKey: board, action: "visit" }, `${owner}:${location.key}:${board}`);
    }, [allowed, owner, board, location.key]);
    useEffect(() => {
        if (!allowed || !board) return;
        const send = (action: UsageAction, controlKey: UsageControlKey, element?: Element | null, parameters?: UsageParameters) => {
            const current = useUserStore.getState();
            if (current.status !== "authenticated" || current.user?.id !== owner || current.user?.status !== "active") return;
            const override = element?.closest("[data-usage-board]")?.getAttribute("data-usage-board");
            if (override && !usageBoardAvailable(override, useModuleStore.getState().flags, useBusinessConfigStore.getState().tools)) return;
            const actualBoard = override || board;
            if (!usageBoardAvailable(actualBoard, useModuleStore.getState().flags, useBusinessConfigStore.getState().tools)) return;
            recordUsage({ eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), boardKey: actualBoard, action, controlKey, ...(parameters ? { parameters } : {}) });
        };
        const event = (action: UsageAction) => (native: Event) => {
            const source = usageElement(native.target);
            if (!source || source === document.body || source === document.documentElement || usagePrivate(source) || source.closest('[disabled], [aria-disabled="true"]')) return;
            const classified = classifyUsageElement(source);
            const ids = new Map(useBusinessConfigStore.getState().models.flatMap(model => [[model.id, model.id], [model.modelId, model.id]] as [string, string][]));
            const effective = action === "click" && ["download", "canvas-tool.download"].includes(classified.controlKey) ? "download" : action === "click" && classified.controlKey === "export" ? "export" : action;
            send(effective, classified.controlKey, source, usageParameters(classified.element, classified.controlKey, action, ids));
        };
        const click = event("click"), change = event("change"), submit = event("submit"), drop = event("drop");
        const model = (native: Event) => {
            const detail = (native as CustomEvent<{ action?: unknown; modelConfigId?: unknown }>).detail;
            if (detail?.action === "open") send("open", "model");
            if (detail?.action === "change") {
                const id = detail.modelConfigId;
                const valid = typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) && useBusinessConfigStore.getState().models.some(item => item.id === id);
                send("change", "model", null, valid ? { modelConfigId: id as string } : undefined);
            }
        };
        const keydown = (native: KeyboardEvent) => { const command = usageCommand(native); if (command) send("click", command, usageElement(native.target)); };
        let gesture: { x: number; y: number; element: Element; slider: boolean } | null = null;
        const down = (native: PointerEvent) => {
            const source = usageElement(native.target);
            const slider = source?.closest('[role="slider"], input[type="range"]');
            if (slider && !usagePrivate(slider)) { gesture = { x: native.clientX, y: native.clientY, element: slider, slider: true }; return; }
            if (!source || usagePrivate(source) || source.closest('input, textarea, button, select, [role="button"], [role="slider"]')) return;
            if (source.closest('[data-node-id], [data-canvas-resize-handle], [data-canvas-connection-handle], canvas, [draggable="true"]')) gesture = { x: native.clientX, y: native.clientY, element: source, slider: false };
        };
        const up = (native: PointerEvent) => { if (gesture && (gesture.slider || Math.hypot(native.clientX - gesture.x, native.clientY - gesture.y) >= 4)) send("change", gesture.slider ? classifyUsageElement(gesture.element).controlKey : "drag", gesture.element); gesture = null; };
        const keyup = (native: KeyboardEvent) => { const target = usageElement(native.target); if (!native.repeat && !native.isComposing && target?.matches('[role="slider"], input[type="range"]') && !usagePrivate(target) && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(native.key)) send("change", classifyUsageElement(target).controlKey, target); };
        const cancel = () => { gesture = null; };
        const dragend = (native: DragEvent) => { const target = usageElement(native.target); if (target && !usagePrivate(target)) send("change", "drag", target); gesture = null; };
        document.addEventListener("click", click, true); document.addEventListener("change", change, true); document.addEventListener("submit", submit, true); document.addEventListener("drop", drop, true);
        document.addEventListener("keydown", keydown, true); document.addEventListener("pointerdown", down, true); document.addEventListener("pointerup", up, true); document.addEventListener("pointercancel", cancel, true);
        document.addEventListener("keyup", keyup, true);
        document.addEventListener("dragend", dragend, true);
        window.addEventListener("online", flushUsage);
        window.addEventListener("business-model-usage", model);
        const hidden = () => { if (document.visibilityState === "hidden") flushUsage(); }; document.addEventListener("visibilitychange", hidden);
        return () => {
            document.removeEventListener("click", click, true); document.removeEventListener("change", change, true); document.removeEventListener("submit", submit, true); document.removeEventListener("drop", drop, true);
            document.removeEventListener("keydown", keydown, true); document.removeEventListener("pointerdown", down, true); document.removeEventListener("pointerup", up, true); document.removeEventListener("pointercancel", cancel, true);
            document.removeEventListener("keyup", keyup, true);
            document.removeEventListener("dragend", dragend, true);
            window.removeEventListener("online", flushUsage); document.removeEventListener("visibilitychange", hidden);
            window.removeEventListener("business-model-usage", model);
        };
    }, [allowed, board, owner]);
}
