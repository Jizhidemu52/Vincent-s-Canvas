import { afterEach, expect, test } from "bun:test";
import { setUiLocale, uiText } from "../src/lib/i18n";
import { displayText, displayTranslationStatus, queueDisplayTranslations } from "../src/lib/display-translations";
import { displayValue } from "../src/lib/display-value";
import { requestDisplayTranslations } from "../src/services/api/display-translations";
import { useUserStore, type LocalUser } from "../src/stores/use-user-store";
import { formatDuration } from "../src/lib/image-utils";
import { canvasImageModelDetails } from "../src/lib/canvas/canvas-model-picker-options";
import { imageModelProfile } from "../src/lib/image-model-settings";

const originalFetch = globalThis.fetch;
let sequence = 0;
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
test("duration display switches units while Chinese formatting remains exact", async () => {
    await setUiLocale("zh-CN"); expect(formatDuration(65000)).toBe("1分05秒"); expect(formatDuration(0)).toBe("0秒");
    await setUiLocale("en-US"); expect(formatDuration(65000)).toBe("1 min 05 s"); expect(formatDuration(0)).toBe("0 s");
    await setUiLocale("zh-CN"); expect(formatDuration(65000)).toBe("1分05秒");
});
test("model capability counts localize without changing the pure summary or capability values", async () => {
    const profile = imageModelProfile("gpt-image-2.6-flare", []);
    const references = { minimum: 0, maximum: 16, supportsReferences: true };
    const before = JSON.stringify({ profile, references });
    const original = canvasImageModelDetails(profile, references);
    await setUiLocale("en-US");
    expect(canvasImageModelDetails(profile, references, uiText)).toContain("Up to 16 reference images");
    expect(canvasImageModelDetails(profile, { ...references, minimum: 2, maximum: 4 }, uiText)).toContain("2–4 reference images");
    expect(canvasImageModelDetails(profile, references)).toEqual(original);
    await setUiLocale("zh-CN");
    expect(canvasImageModelDetails(profile, references, uiText)).toEqual(original);
    expect(JSON.stringify({ profile, references })).toBe(before);
});
function signIn(id = `display-owner-${++sequence}`) {
    useUserStore.setState({ status: "authenticated", user: { id, username: id, displayName: "原姓名", role: "designer", status: "active", avatarUrl: "" } as LocalUser });
    return id;
}
afterEach(async () => {
    globalThis.fetch = originalFetch;
    await setUiLocale("zh-CN");
    useUserStore.setState({ status: "guest", user: null });
    await sleep(175);
});

test("Chinese and signed-out display never submit translation or change original values", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error("Unexpected request"); }) as typeof fetch;
    signIn();
    queueDisplayTranslations(["这是我的原稿"]);
    await sleep(200);
    expect(displayText("这是我的原稿")).toBe("这是我的原稿");
    useUserStore.setState({ status: "guest", user: null });
    await setUiLocale("en-US");
    queueDisplayTranslations(["这是我的原稿"]);
    await sleep(200);
    expect(calls).toBe(0);
});

test("English batches deduplicate visible sources, preserve source, and reuse only the current owner's cache", async () => {
    const owner = signIn(), requests: Array<{ owner: string | null; texts: string[] }> = [];
    globalThis.fetch = (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push({ owner: new Headers(init?.headers).get("X-Canvas-Owner-Id"), texts: body.texts });
        return Response.json({ translations: body.texts.map((_text: string, index: number) => `English ${index}`) });
    }) as typeof fetch;
    const sources = Object.freeze(["自定义红毛衫原稿", "自定义蓝毛衫原稿"]);
    await setUiLocale("en-US");
    queueDisplayTranslations([...sources, sources[0], "保存", "already English"]);
    await sleep(250);
    expect(requests).toEqual([{ owner, texts: sources }]);
    expect(displayText(sources[0])).toBe("English 0");
    expect(displayText("保存")).toBe("Save");
    queueDisplayTranslations(sources); await sleep(200);
    expect(requests).toHaveLength(1);
    await setUiLocale("zh-CN"); expect(displayText(sources[0])).toBe(sources[0]);
    signIn(); await setUiLocale("en-US");
    expect(displayText(sources[0])).toBe(sources[0]);
    queueDisplayTranslations(sources); await sleep(250);
    expect(requests).toHaveLength(2);
    expect(requests[1].owner).not.toBe(owner);
    expect(sources[0]).toBe("自定义红毛衫原稿");
});

test("failed or oversized display translations preserve originals and never retry on language toggles", async () => {
    signIn(); let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ error: "unavailable" }, { status: 503 }); }) as typeof fetch;
    await setUiLocale("en-US");
    const source = "暂时翻译失败的原文", large = "原".repeat(12001);
    queueDisplayTranslations([source, large]); await sleep(250);
    expect(displayTranslationStatus(source)).toBe("unavailable");
    expect(displayTranslationStatus(large)).toBe("unavailable");
    expect(displayText(source)).toBe(source);
    expect(displayText(large)).toBe(large);
    await setUiLocale("zh-CN"); await setUiLocale("en-US");
    queueDisplayTranslations([source, large]); await sleep(200);
    expect(calls).toBe(1);
});

test("late response cannot reveal the previous account's display translation", async () => {
    const first = signIn(); let resolve!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>(done => { resolve = done; })) as typeof fetch;
    const pending = requestDisplayTranslations(["私人原稿"], first);
    signIn(); resolve(Response.json({ translations: ["Private original"] }));
    await expect(pending).rejects.toThrow("identity changed");
    await setUiLocale("en-US");
    expect(displayText("私人原稿")).toBe("私人原稿");
});

test("display JSON translates human text leaves but preserves identifiers, secrets, links and the complete input", () => {
    const source = { title: "服装原稿", parameters: { prompt: "保留花纹", size: "1024x1024", modelId: "模型标识", avoid: ["口袋"], sourceUrl: "/api/assets/原图/content" },
        credentials: { name: "机密键名", prompt: "不应外发" }, nodeId: "中文编号", note: "https://example.test/原文" };
    const before = JSON.stringify(source), seen: string[] = [];
    const translated = displayValue(source, text => { seen.push(text); return `English:${text}`; }) as typeof source;
    expect(seen).toEqual(["服装原稿", "保留花纹", "口袋"]);
    expect(translated.parameters.modelId).toBe(source.parameters.modelId);
    expect(translated.parameters.sourceUrl).toBe(source.parameters.sourceUrl);
    expect(translated.credentials).toEqual(source.credentials);
    expect(JSON.stringify(source)).toBe(before);
});
