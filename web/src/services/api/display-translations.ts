import { useUserStore } from "@/stores/use-user-store";

/** This owner guard also covers department administrators, who cannot create
 * personal workspace tasks but may translate their authorized display text. */
export async function requestDisplayTranslations(texts: string[], ownerId: string): Promise<string[]> {
    const activeOwner = () => {
        const { status, user } = useUserStore.getState();
        return status === "authenticated" ? user?.id : undefined;
    };
    if (!ownerId || activeOwner() !== ownerId) throw new Error("Display translation identity changed");
    const response = await fetch("/api/display-translations", {
        method: "POST", credentials: "include", redirect: "error", cache: "no-store",
        headers: { "content-type": "application/json", "X-Canvas-Owner-Id": ownerId },
        body: JSON.stringify({ target: "en-US", texts }),
    });
    if (response.status !== 200) throw new Error("Display translation unavailable");
    const result: unknown = await response.json();
    if (activeOwner() !== ownerId) throw new Error("Display translation identity changed");
    if (!result || typeof result !== "object" || !("translations" in result) || !Array.isArray(result.translations)
        || result.translations.length !== texts.length || result.translations.some(text => typeof text !== "string" || !text.trim() || text.length > 48000)) throw new Error("Invalid display translation");
    return result.translations as string[];
}
