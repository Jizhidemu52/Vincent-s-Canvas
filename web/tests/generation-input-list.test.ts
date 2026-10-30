import { expect, test } from "bun:test";
import { designInputValue } from "../src/components/generation-input-list";
import { setUiLocale } from "../src/lib/i18n";

test("English UI translates known enums but preserves designer text and color names verbatim", async () => {
    await setUiLocale("en-US");
    try {
        expect(designInputValue("智能配色", "description")).toBe("智能配色");
        expect(designInputValue("smart", "description")).toBe("smart");
        expect(designInputValue("smart", "colorMode")).not.toBe("smart");
        expect(designInputValue({ library: "用户色库", code: "自编一号", name: "智能配色", hex: "#aabbcc" })).toBe("用户色库 · 自编一号 · 智能配色 · #aabbcc");
        expect(designInputValue(["结构", "pattern"], "description")).toBe("结构；pattern");
    } finally { await setUiLocale("zh-CN"); }
});
