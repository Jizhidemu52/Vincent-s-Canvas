/** UI retirement only: internal tool bindings and stored work remain untouched. */
export function retiredWorkbenchName(pathname: string, search = ""): string | undefined {
    const path = pathname.replace(/\/$/, "");
    const key = path === "/image" ? new URLSearchParams(search).get("tool") : path.startsWith("/creative/") ? path.slice("/creative/".length) : path.slice(1);
    if (key === "detail-enhance") return "细节增强";
    if (key === "angle-control") return "角度控制";
    if (key === "series-recipe") return "系列配方";
    return undefined;
}
