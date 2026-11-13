export type DisplayConfigKind = "columns" | "options";
const humanColumn = /^(?:name|title|label|displayName|userName|actorName|ownerName|departmentName|groupName|modelName|projectName|description|prompt|summary|message|failureReason|note|content)$/;

/** Copy presentation configuration only. Table row values, option values,
 * sort/filter callbacks and the original config objects remain unchanged. */
export function translateDisplayConfig<T>(value: T, kind: DisplayConfigKind, translate: (source: string) => string, renderText: (source: string) => unknown = translate): T {
    if (Array.isArray(value)) return value.map(item => translateDisplayConfig(item, kind, translate, renderText)) as T;
    if (!value || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;
    const next = { ...source };
    for (const key of kind === "columns" ? ["title"] : ["label", "title"]) {
        if (typeof source[key] === "string") next[key] = translate(source[key]);
    }
    const field = Array.isArray(source.dataIndex) ? source.dataIndex.at(-1) : source.dataIndex;
    if (kind === "columns" && typeof field === "string" && humanColumn.test(field)) {
        const originalRender = source.render;
        next.render = (...args: unknown[]) => {
            const rendered: unknown = typeof originalRender === "function" ? Reflect.apply(originalRender, undefined, args) : args[0];
            return typeof rendered === "string" ? renderText(rendered) : rendered;
        };
    }
    for (const key of ["children", "options"]) if (Array.isArray(source[key])) next[key] = translateDisplayConfig(source[key], kind, translate, renderText);
    return next as T;
}
