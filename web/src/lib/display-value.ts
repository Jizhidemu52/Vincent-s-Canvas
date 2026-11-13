const humanTextKey = /^(?:title|name|displayName|label|description|summary|prompt|userText|text|content|message|note|notes|reason|failureReason|brief|evidence|caption|tags|keywords|requirements|must|avoid|unknowns|colors|materials|subject|purpose|steps|location|explanation)$/i;
const protectedKey = /^(?:ids?|urls?|uris?|paths?|keys?|tokens?|secrets?|passwords?|credentials?|signature|code|model|provider|expression|html|sql|script|endpoint|host|email)$/i;
const protectedSuffix = /(?:Id|Ids|Url|Urls|URI|URL|Path|Key|Token|Secret|Password|Credentials?|Signature|Code)$|_(?:id|ids|url|path|key|token|secret|password|credential|signature|code)$/;

/** Translate human-readable JSON leaves for presentation, not identifiers,
 * credentials, code or transport values. Never mutates the input object. */
export function displayValue(value: unknown, translate: (source: string) => string, field = "", depth = 0): unknown {
    if (depth > 32 || protectedKey.test(field) || protectedSuffix.test(field)) return value;
    if (typeof value === "string") {
        if (!humanTextKey.test(field) || /^(?:https?:|data:|blob:|\/api\/)/i.test(value)) return value;
        return translate(value);
    }
    if (Array.isArray(value)) return value.map(item => displayValue(item, translate, field, depth + 1));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, displayValue(item, translate, key, depth + 1)]));
}
