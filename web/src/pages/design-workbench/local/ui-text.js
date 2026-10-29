import { subscribeUiLocale, uiText } from "@/lib/i18n";

const bindings = new WeakMap();

/** Only explicitly marked application labels are translated. User project names,
 * input values, layer names and artwork never enter this binding system. */
export function setWorkbenchText(element, source, parameters) {
    if (!element) return;
    bindings.set(element, { source, parameters });
    element.dataset.uiBound = "true";
    updateText(element);
}

function updateText(element) {
    const binding = bindings.get(element);
    const source = binding?.source ?? element.dataset.uiText;
    if (source === undefined) return;
    const value = typeof source === "function" ? source() : uiText(source, binding?.parameters);
    if (element.textContent !== value) element.textContent = value;
}

export function watchWorkbenchUi(root, signal) {
    const refresh = () => {
        if (signal.aborted) return;
        root.querySelectorAll("[data-ui-text], [data-ui-bound]").forEach(updateText);
        for (const attribute of ["title", "aria-label"]) {
            root.querySelectorAll(`[data-ui-${attribute}]`).forEach(element => {
                const value = uiText(element.getAttribute(`data-ui-${attribute}`));
                if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
            });
        }
        root.querySelectorAll("[data-ui-label-action]").forEach(element => {
            const value = `${uiText(element.dataset.uiLabelAction)} ${element.dataset.uiLabelName || ""}`;
            if (element.getAttribute("aria-label") !== value) element.setAttribute("aria-label", value);
        });
    };
    const unsubscribe = subscribeUiLocale(refresh);
    signal.addEventListener("abort", unsubscribe, { once: true });
    refresh();
    return refresh;
}
