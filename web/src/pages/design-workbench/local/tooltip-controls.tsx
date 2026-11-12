import { Tooltip } from "antd";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { uiText, useUiText } from "@/lib/i18n";
import "./tooltip-controls.css";

type TooltipControl = { native: HTMLButtonElement; target: HTMLElement; key: number };

function NativeButtonTooltip({ native }: { native: HTMLButtonElement }) {
    const trigger = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
        // Move the same button into the trigger: its properties, DOM listeners
        // and the editor's delegated action handlers remain authoritative.
        trigger.current?.append(native);
    }, [native]);

    return <Tooltip title={uiText(native.dataset.workbenchTooltip || "")} trigger={["hover", "focus"]} destroyOnHidden>
        <span ref={trigger} className="local-workbench-tooltip-trigger" />
    </Tooltip>;
}

/** Present only explicitly marked local editor buttons through the React host. */
export function LocalWorkbenchTooltips({ root }: { root: HTMLElement }) {
    useUiText();
    const [controls, setControls] = useState<TooltipControl[]>([]);
    useEffect(() => {
        const mounted = new Map<HTMLButtonElement, TooltipControl>();
        let sequence = 0;
        const refresh = () => {
            const natives = new Set(root.querySelectorAll<HTMLButtonElement>("button[data-workbench-tooltip]"));
            for (const [native, control] of mounted) if (!natives.has(native)) { control.target.remove(); mounted.delete(native); }
            for (const native of natives) if (!mounted.has(native)) {
                const target = document.createElement("span");
                target.dataset.workbenchTooltipControl = native.dataset.action || "visibility";
                target.style.display = "contents";
                native.before(target);
                mounted.set(native, { native, target, key: ++sequence });
            }
            setControls([...mounted.values()]);
        };
        root.addEventListener("workbench:tooltips-changed", refresh);
        refresh();
        return () => {
            root.removeEventListener("workbench:tooltips-changed", refresh);
            for (const { native, target } of mounted.values()) {
                if (root.contains(target)) target.before(native);
                target.remove();
            }
        };
    }, [root]);

    return controls.map(({ native, target, key }) => createPortal(<NativeButtonTooltip native={native} />, target, String(key)));
}
