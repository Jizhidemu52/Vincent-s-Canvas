type Timestamp = string | number | Date | null | undefined;

const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** Display an instant in Beijing time without modifying stored timestamps or guessing a missing timezone. */
export function formatBeijingDateTime(value: Timestamp): string {
    if (value == null || (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value))) return "—";
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return "—";
    const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatBeijingTime(value: Timestamp): string {
    const text = formatBeijingDateTime(value);
    return text === "—" ? text : text.slice(11);
}
