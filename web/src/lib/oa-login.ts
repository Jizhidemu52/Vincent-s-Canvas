export const OA_ENTRY_URL = "https://oa.in-choice.com.cn:82/";

// Keep the credential only in the caller's memory, never router state or storage.
// null means absent; an empty/duplicated token is still an explicit login attempt.
export function consumeOaLoginToken(location: Pick<Location, "href">, history: Pick<History, "state" | "replaceState">): string | null {
    const url = new URL(location.href);
    if (!url.searchParams.has("token")) return null;
    const tokens = url.searchParams.getAll("token");
    url.searchParams.delete("token");
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
    return tokens.length === 1 ? tokens[0] : "";
}
