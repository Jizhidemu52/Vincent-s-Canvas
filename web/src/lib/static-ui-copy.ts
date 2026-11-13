import { uiText } from "./i18n";

/** Localize a display value, keeping React nodes, numeric values and source objects intact. */
export function staticUiText<T>(value: T, parameters?: Record<string, string | number>): T {
    return (typeof value === "string" ? uiText(value, parameters) : value) as T;
}

export type StaticUiConfigKind = "options" | "columns" | "rules" | "items" | "menu" | "modal" | "notification";
const displayKeys: Record<StaticUiConfigKind, readonly string[]> = {
    options: ["label", "title"],
    columns: ["title"],
    rules: ["message"],
    items: ["label", "title", "description"],
    menu: [],
    modal: ["title", "content", "okText", "cancelText"],
    notification: ["message", "description"],
};

/** Copy only UI configuration at its render boundary. Values, keys, rules and callbacks stay literal. */
export function staticUiConfig<T>(value: T, kind: StaticUiConfigKind): T {
    if (Array.isArray(value)) return value.map(item => staticUiConfig(item, kind)) as T;
    if (!value || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;
    const next = { ...source };
    for (const key of displayKeys[kind]) if (Object.hasOwn(source, key)) next[key] = staticUiText(source[key]);
    if (kind === "menu" && Array.isArray(source.items)) next.items = staticUiConfig(source.items, "items");
    if (["options", "columns", "items"].includes(kind) && Array.isArray(source.children)) next.children = staticUiConfig(source.children, kind);
    return next as T;
}
