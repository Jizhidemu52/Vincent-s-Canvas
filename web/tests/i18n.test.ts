import { afterEach, expect, test } from "bun:test";
import { getUiLocale, initializeUiLocale, setUiLocale, setUiPathname, uiText, UI_LOCALE_KEY } from "../src/lib/i18n";
import english from "../src/lib/i18n/en";

afterEach(async () => { setUiPathname("/"); await setUiLocale("zh-CN"); });

test("admin pages stay Chinese and returning to employee pages restores the preferred language", async () => {
    await setUiLocale("en-US");
    for (const pathname of ["/admin", "/admin/login", "/admin/prompt-recipes", "/admin/design-library"]) {
        setUiPathname(pathname);
        expect(getUiLocale()).toBe("zh-CN");
        expect(uiText("保存")).toBe("保存");
    }
    setUiPathname("/canvas");
    expect(getUiLocale()).toBe("en-US");
    expect(uiText("保存")).toBe("Save");
});

test("Chinese is the default and known UI copy can switch back without changing literal parameters", async () => {
    expect(getUiLocale()).toBe("zh-CN");
    expect(uiText("保存")).toBe("保存");
    await setUiLocale("en-US");
    expect(uiText("保存")).toBe("Save");
    expect(uiText("{label}（常用）", { label: "我的中文作品 {count}" })).toBe("我的中文作品 {count} (frequent)");
    expect(uiText("用户自写的文字，不在界面词典内")).toBe("用户自写的文字，不在界面词典内");
    await setUiLocale("zh-CN");
    expect(uiText("保存")).toBe("保存");
});

test("latest language choice wins even while English is loading", async () => {
    await Promise.all([setUiLocale("en-US"), setUiLocale("zh-CN")]);
    expect(getUiLocale()).toBe("zh-CN");
});

test("language preference is isolated and a saved English choice is restored", async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const values = new Map<string, string>([[UI_LOCALE_KEY, "en-US"], ["user-prompt", "原始中文内容"]]);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
    try {
        await initializeUiLocale();
        expect(getUiLocale()).toBe("en-US");
        expect(values.get("user-prompt")).toBe("原始中文内容");
        expect([...values.keys()].sort()).toEqual([UI_LOCALE_KEY, "user-prompt"].sort());
    } finally { if (saved) Object.defineProperty(globalThis, "localStorage", saved); else Reflect.deleteProperty(globalThis, "localStorage"); }
});

test("blocked storage does not prevent in-memory switching", async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("storage blocked"); } });
    try { await setUiLocale("en-US"); expect(getUiLocale()).toBe("en-US"); } finally { if (saved) Object.defineProperty(globalThis, "localStorage", saved); else Reflect.deleteProperty(globalThis, "localStorage"); }
});

test("English UI catalog has nonempty values and preserves placeholders", () => {
    const parameters = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    for (const [source, translated] of Object.entries(english)) {
        expect(translated.trim().length, source).toBeGreaterThan(0);
        expect(parameters(translated), source).toEqual(parameters(source));
    }
});
