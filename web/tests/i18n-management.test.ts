import { afterEach, expect, test } from "bun:test";
import { setUiLocale, uiText } from "@/lib/i18n";
import english from "@/lib/i18n/en-management";
import { accountTemplateCsv, prepareNewAccount } from "@/pages/admin/account-input";
import { buildTestPromptInput, parseVersion } from "@/pages/admin/prompt-recipes/model";

afterEach(async () => { await setUiLocale("zh-CN"); });

test("management translations are nonempty and retain interpolation parameters", () => {
    const parameters = (text: string) => [...new Set(text.match(/\{\w+\}/g) || [])].sort();
    expect(Object.keys(english).length).toBeGreaterThan(1500);
    for (const [source, translated] of Object.entries(english)) {
        expect(translated.trim().length, source).toBeGreaterThan(0);
        expect(parameters(translated), source).toEqual(parameters(source));
    }
});

test("locale switches translate employee resource UI without translating interpolated names", async () => {
    await setUiLocale("en-US");
    expect(uiText("管理中心")).toBe("Management");
    expect(uiText("删除小组“{p0}”？", { p0: "复制" })).toBe("Delete group “复制”?");
    expect(uiText("已删除 {p0} 个素材", { p0: 3 })).toBe("Deleted 3 assets");
    await setUiLocale("zh-CN");
    expect(uiText("管理中心")).toBe("管理中心");
    expect(uiText("已删除 {p0} 个素材", { p0: 3 })).toBe("已删除 3 个素材");
});

test("account data, CSV examples, prompt content and protocol values stay identical across locales", async () => {
    const account = { username: "test-designer", displayName: "复制", employeeNo: "张三", role: "designer" as const, status: "active" as const, creditBalance: 10, creditLimit: 100 };
    const promptInput = { scene: "garment-colorway", fieldsJson: '{"颜色":"图片","备注":"删除"}', userText: "复制", rolesText: "图片\n文本", mode: "edit" as const, outputLanguage: "zh" as const };
    const version = { systemPrompt: "系统提示词", fieldTemplate: "场景字段", overridesJson: '{"model":"保存"}', fallbackPrompt: "取消", outputLanguage: "zh" as const, changeNote: "原样保存" };
    const before = { account: prepareNewAccount(account, true), csv: accountTemplateCsv([], true), prompt: buildTestPromptInput(promptInput), version: parseVersion(version) };
    await setUiLocale("en-US");
    expect(prepareNewAccount(account, true)).toEqual(before.account);
    expect(accountTemplateCsv([], true)).toBe(before.csv);
    expect(buildTestPromptInput(promptInput)).toEqual(before.prompt);
    expect(parseVersion(version)).toEqual(before.version);
    expect(() => prepareNewAccount({ ...account, employeeNo: "" }, true)).toThrow("请输入企业微信成员账号");
});
