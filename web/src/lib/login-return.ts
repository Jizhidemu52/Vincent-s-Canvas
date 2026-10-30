/** Only permit an application-local path, never an absolute/protocol-relative URL. */
export function safeLoginReturn(value: unknown, fallback = "/"): string {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\r\n\u0000]/.test(value)) return fallback;
    try {
        const url = new URL(value, "https://workspace.invalid");
        if (url.origin !== "https://workspace.invalid" || /^\/(?:admin\/)?login(?:\/|$)/.test(url.pathname) || url.pathname === "/change-password") return fallback;
        // OA credentials must never be preserved in a navigation return URL.
        for (const key of ["token", "oa_token", "oaToken", "access_token", "code"]) url.searchParams.delete(key);
        return url.pathname + url.search + url.hash;
    } catch { return fallback; }
}

export function currentLoginReturn(fallback = "/") {
    if (typeof window === "undefined") return fallback;
    const state = window.history.state?.usr?.from;
    const query = new URLSearchParams(window.location.search).get("returnTo");
    const current = /^\/(?:admin\/)?login(?:\/|$)/.test(window.location.pathname) ? undefined : window.location.pathname + window.location.search + window.location.hash;
    return safeLoginReturn(state ?? query ?? current, fallback);
}
