/** Carbon's Chat Completions gateway rejects this schema hint; local argument validation stays authoritative. */
export function carbonToolParameters(parameters: Record<string, unknown>): Record<string, unknown> {
    const visit = (value: unknown): unknown => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value;
        return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "uniqueItems").map(([key, item]) => {
            // These maps contain property names, including a legitimate property named uniqueItems.
            if (["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key) && item && typeof item === "object" && !Array.isArray(item))
                return [key, Object.fromEntries(Object.entries(item).map(([name, schema]) => [name, visit(schema)]))];
            if (["items", "additionalProperties", "additionalItems", "contains", "not", "if", "then", "else", "propertyNames"].includes(key))
                return [key, Array.isArray(item) ? item.map(visit) : visit(item)];
            if (["anyOf", "allOf", "oneOf", "prefixItems"].includes(key) && Array.isArray(item)) return [key, item.map(visit)];
            // Data literals (default/examples/enum/const), descriptions and required names are not schemas.
            return [key, item];
        }));
    };
    return visit(parameters) as Record<string, unknown>;
}
