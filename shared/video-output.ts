/** Empty means upstream randomness. Do not invent a provider range for Seedance. */
export function parseVideoSeed(value: unknown, maximum?: number): number | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    const numeric = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN;
    if (!Number.isSafeInteger(numeric)) throw new Error("随机种子必须为可精确表示的整数，留空则随机");
    if (maximum !== undefined && (numeric < 0 || numeric > maximum)) throw new Error(`随机种子必须在 0–${maximum} 之间`);
    return numeric;
}

export function videoFileExtension(mimeType?: string) {
    const mime = mimeType?.split(";")[0]?.trim().toLowerCase();
    return mime === "video/quicktime" ? "mov" : mime === "video/webm" ? "webm" : "mp4";
}
