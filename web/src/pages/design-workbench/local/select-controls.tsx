import { Select } from "antd";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { uiText, useUiText } from "@/lib/i18n";

type SelectControl = { native: HTMLSelectElement; target: HTMLElement; key: number };

/** Keep the local editors' DOM values/change handlers as the business boundary.
 * Only these explicitly marked controls receive a React presentation. */
export function LocalWorkbenchSelects({ root }: { root: HTMLElement }) {
    useUiText();
    const [controls, setControls] = useState<SelectControl[]>([]);
    useEffect(() => {
        const mounted = new Map<HTMLSelectElement, SelectControl>();
        let sequence = 0;
        const refresh = () => {
            const natives = new Set(root.querySelectorAll<HTMLSelectElement>("select[data-workbench-select]"));
            for (const [native, control] of mounted) if (!natives.has(native)) { control.target.remove(); mounted.delete(native); }
            for (const native of natives) if (!mounted.has(native)) {
                const target = document.createElement("span");
                target.dataset.workbenchSelectControl = native.dataset.workbenchSelect;
                Object.assign(target.style, { display: "inline-block", width: native.dataset.workbenchSelect === "project" ? "min(260px, 65vw)" : "100%", maxWidth: "100%", verticalAlign: "middle" });
                native.after(target);
                native.hidden = true;
                mounted.set(native, { native, target, key: ++sequence });
            }
            setControls([...mounted.values()]);
        };
        root.addEventListener("workbench:selects-changed", refresh);
        refresh();
        return () => {
            root.removeEventListener("workbench:selects-changed", refresh);
            for (const { native, target } of mounted.values()) { native.hidden = false; target.remove(); }
        };
    }, [root]);

    return controls.map(({ native, target, key }) => createPortal(
        <span onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
            <Select<string>
                size="small"
                aria-label={uiText(native.dataset.uiAriaLabel || native.getAttribute("aria-label") || "")}
                value={native.value}
                disabled={native.disabled || Boolean(native.closest("[inert]"))}
                style={{ width: "100%" }}
                styles={{ input: { border: 0, borderRadius: 0, padding: 0, background: "transparent", outline: "none" } }}
                options={[...native.options].map(option => ({ value: option.value, label: option.dataset.uiText ? uiText(option.dataset.uiText) : option.label, disabled: option.disabled }))}
                onChange={value => {
                    if (!root.contains(native) || native.disabled || native.closest("[inert]")) return;
                    native.value = value;
                    native.dispatchEvent(new Event("input", { bubbles: true }));
                    native.dispatchEvent(new Event("change", { bubbles: true }));
                    root.dispatchEvent(new Event("workbench:selects-changed"));
                }}
            />
        </span>, target, String(key),
    ));
}
