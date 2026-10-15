import { USAGE_CANVAS_CONTROL_PATTERN, USAGE_CONTROLS, USAGE_FALLBACK_CONTROL_PATTERN, type UsageAction, type UsageControlKey, type UsageParameters } from "../../../shared/usage-analytics";

const controls = new Set<string>(USAGE_CONTROLS);
const roleNames = new Set(["switch", "checkbox", "radio", "tab", "menuitem", "slider", "option"]);
const tags = new Set(["button", "a", "input", "select", "textarea", "img", "div", "span"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeLabels: Record<string, UsageControlKey> = { "宽高比": "size", "尺寸": "size", "尺寸 / 比例": "size", "比例预设": "size", "清晰度 / 分辨率": "resolution", "分辨率": "resolution", "图片质量": "quality", "质量": "quality", "模型": "model", "图像模型": "model", "对话模型": "model", "选择模型": "model", "撤销": "undo", "重做": "redo", "下载": "download", "导出": "export", "生成": "submit", "开始生成": "submit", "发送": "submit" };
export function usageElement(target: EventTarget | null): Element | null { return target instanceof Element ? target : target instanceof Node ? target.parentElement : null; }
export function canvasUsageControl(id: string): UsageControlKey {
    const alias = ({ replace: "upload", resize: "freeResize", view: "viewImage" } as Record<string, string>)[id] || id;
    const key = `canvas-tool.${alias}`;
    return USAGE_CANVAS_CONTROL_PATTERN.test(key) ? key as UsageControlKey : "canvas-tool";
}
export function usagePrivate(element: Element | null): boolean {
    if (!element) return true;
    if (element.closest('[data-usage-private], [data-usage-ignore], input[type="password"], [autocomplete="current-password"], [autocomplete="new-password"], [autocomplete="one-time-code"]')) return true;
    // Attribute names decide exclusion only. Values, DOM text and user content are never read here.
    for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
        for (const name of ["name", "id", "aria-label", "placeholder", "autocomplete"]) {
            if (/(?:password|api[\s_-]?key|access[\s_-]?token|secret|credential|密码|密钥|令牌)/i.test(node.getAttribute(name) || "")) return true;
        }
        if (node.matches('form, [role="dialog"]') && node.querySelector('input[type="password"], [autocomplete="current-password"], [autocomplete="new-password"]')) return true;
    }
    return false;
}
/** Index-only path: no URL, DOM text, user IDs, class names, filenames or input values. */
export function fallbackUsageControl(element: Element): UsageControlKey {
    const role = element.getAttribute("role") || "";
    const tag = roleNames.has(role) ? role : tags.has(element.tagName.toLowerCase()) ? element.tagName.toLowerCase() : "div";
    const parts: number[] = [];
    for (let node: Element | null = element; node?.parentElement && parts.length < 12; node = node.parentElement) {
        const index = Array.prototype.indexOf.call(node.parentElement.children, node) + 1;
        parts.unshift(Math.min(9999, Math.max(1, index)));
        if (node.parentElement === document.body) break;
    }
    const key = `fallback:${tag}:${parts.join(".") || "1"}` as UsageControlKey;
    return USAGE_FALLBACK_CONTROL_PATTERN.test(key) ? key : "fallback:div:1";
}
function explicitControl(element: Element): UsageControlKey | undefined {
    const value = element.getAttribute("data-usage-control") || "";
    return controls.has(value) || USAGE_CANVAS_CONTROL_PATTERN.test(value) ? value as UsageControlKey : undefined;
}
export function classifyUsageElement(element: Element): { controlKey: UsageControlKey; element: Element } {
    const marked = element.closest("[data-usage-control]");
    const explicit = marked && explicitControl(marked);
    if (marked && explicit) return { controlKey: explicit, element: marked };
    const target = element.closest('button, a, select, input, textarea, [role="button"], [role="switch"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="slider"], [role="option"], summary') || element;
    const label = target.getAttribute("aria-label") || target.getAttribute("title") || "";
    const controlKey = target.matches('a[download]') ? "download" : target.matches("a") ? "navigation"
        : target.matches('input[type="file"]') ? "reference-upload" : target.matches('[role="tab"]') ? "tab"
        : target.matches('button[type="submit"], input[type="submit"]') ? "submit" : safeLabels[label] || fallbackUsageControl(target);
    return { controlKey, element: target };
}
export function usageParameters(element: Element, controlKey: UsageControlKey, action: UsageAction, modelIds: ReadonlyMap<string, string>): UsageParameters | undefined {
    const result: UsageParameters = {};
    // Only declared parameter controls are read; arbitrary text inputs/textarea never are.
    const declared = explicitControl(element);
    const value = element.getAttribute("data-usage-value") ?? (action === "change" && element instanceof HTMLSelectElement && declared ? element.value : "");
    const modelId = controlKey === "model" ? modelIds.get(value) : undefined;
    if (modelId && uuid.test(modelId)) result.modelConfigId = modelId;
    if (controlKey === "resolution" && ["0.5K", "1K", "2K", "4K", "720P", "1080P"].includes(value.toUpperCase())) result.resolution = value.toUpperCase() as UsageParameters["resolution"];
    if (controlKey === "quality" && ["auto", "low", "medium", "high", "xhigh", "max"].includes(value)) result.quality = value as UsageParameters["quality"];
    if (controlKey === "size" && /^(?:auto|[1-9]\d?(?:\.5)?[:x][1-9]\d?(?:\.5)?)$/.test(value)) result.aspectRatio = value;
    if (action === "change" && element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) result.enabled = element.checked;
    if (action === "change" && element instanceof HTMLInputElement && element.type === "file") result.referenceCount = Math.min(32, element.files?.length || 0);
    return Object.keys(result).length ? result : undefined;
}
export function usageCommand(event: KeyboardEvent): UsageControlKey | null {
    const element = usageElement(event.target);
    if (event.repeat || event.isComposing || usagePrivate(element) || element?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return null;
    const command = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (command && key === "z") return event.shiftKey ? "redo" : "undo";
    if (command && key === "y") return "redo";
    if (command && key === "v") return "paste";
    if (command && ["+", "-", "=", "0"].includes(key)) return "zoom";
    if (!command && ["delete", "backspace"].includes(key)) return "delete-selection";
    return null;
}
