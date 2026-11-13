import { subscribeUiLocale, uiText } from "@/lib/i18n";
import { displayText, queueDisplayTranslations, subscribeDisplayTranslations } from "@/lib/display-translations";

const bindings = new WeakMap();

/** Only explicitly marked display nodes are translated. Original state, input
 * values, exported names and artwork never enter this binding system. */
export function setWorkbenchText(element, source, parameters) {
    if (!element) return;
    bindings.set(element, { source, parameters });
    element.dataset.uiBound = "true";
    updateText(element);
}

export function setWorkbenchDisplayText(element, source) {
    if (!element) return;
    element.dataset.uiDisplayText = source;
    updateText(element);
}

function updateText(element) {
    const binding = bindings.get(element);
    const source = binding?.source ?? element.dataset.uiDisplayText ?? element.dataset.uiText;
    if (source === undefined) return;
    const raw = typeof source === "function" ? source() : uiText(source, binding?.parameters);
    queueDisplayTranslations([raw]);
    const value = displayText(raw);
    if (element.textContent !== value) { element.textContent = value; return true; }
    return false;
}

export function watchWorkbenchUi(root, signal) {
    const refresh = () => {
        if (signal.aborted) return;
        let optionsChanged = false;
        root.querySelectorAll("[data-ui-text], [data-ui-bound], [data-ui-display-text]").forEach(element => {
            if (updateText(element) && element.tagName === "OPTION") optionsChanged = true;
        });
        for (const attribute of ["aria-label"]) {
            root.querySelectorAll(`[data-ui-${attribute}]`).forEach(element => {
                const value = uiText(element.getAttribute(`data-ui-${attribute}`));
                if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
            });
        }
        root.querySelectorAll("[data-ui-label-action]").forEach(element => {
            const name = element.dataset.uiLabelName || "";
            queueDisplayTranslations([name]);
            const value = `${uiText(element.dataset.uiLabelAction)} ${displayText(name)}`;
            if (element.getAttribute("aria-label") !== value) element.setAttribute("aria-label", value);
        });
        if (optionsChanged) root.dispatchEvent(new Event("workbench:selects-changed"));
    };
    const unsubscribe = subscribeUiLocale(refresh);
    const unsubscribeDisplay = subscribeDisplayTranslations(refresh);
    signal.addEventListener("abort", unsubscribe, { once: true });
    signal.addEventListener("abort", unsubscribeDisplay, { once: true });
    refresh();
    return refresh;
}
