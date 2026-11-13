import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { setUiLocale, uiText } from "../src/lib/i18n";
import { staticUiConfig, staticUiText } from "../src/lib/static-ui-copy";
import { adminLabel } from "../src/pages/admin/admin-labels";

afterEach(async () => { await setUiLocale("zh-CN"); });

test("static text only translates display strings and preserves other values and nodes", async () => {
    const node = createElement("strong", null, "用户原文");
    const values = [undefined, null, false, 0, 42, node, { title: "用户原文" }];
    await setUiLocale("en-US");
    for (const value of values) expect(staticUiText(value)).toBe(value);
    expect(staticUiText("取消")).toBe(uiText("取消"));
    expect(staticUiText("{count} 个用户原文", { count: 3 })).toBe("3 个用户原文");
});

test("render config copies are reversible without changing values keys prompts or callbacks", async () => {
    const callback = () => "原始回调";
    const options = Object.freeze([Object.freeze({ label: "取消", title: "确定", value: "取消", key: "确定", prompt: "中文业务提示词", onClick: callback, children: Object.freeze([Object.freeze({ label: "确定", value: "中文值" })]) })]);
    const original = JSON.stringify(options);
    expect(staticUiConfig(options, "options")).toEqual(options);
    await setUiLocale("en-US");
    const english = staticUiConfig(options, "options");
    expect(english).not.toBe(options);
    expect(english[0].label).toBe(uiText("取消"));
    expect(english[0].value).toBe("取消");
    expect(english[0].key).toBe("确定");
    expect(english[0].prompt).toBe("中文业务提示词");
    expect(english[0].onClick).toBe(callback);
    expect(english[0].children[0].value).toBe("中文值");
    expect(JSON.stringify(options)).toBe(original);
    await setUiLocale("zh-CN");
    expect(staticUiConfig(options, "options")).toEqual(options);
});

test("column render functions rules and menu identity stay intact", async () => {
    const render = () => "用户自定义名称";
    const column = { title: "状态", dataIndex: "状态", key: "状态", render };
    const rule = { message: "确定", required: true, validator: render };
    const menu = { selectedKeys: ["中文键"], items: [{ key: "中文键", label: "取消", onClick: render }] };
    await setUiLocale("en-US");
    expect(staticUiConfig([column], "columns")[0]).toEqual({ ...column, title: uiText("状态") });
    expect(staticUiConfig([rule], "rules")[0]).toEqual({ ...rule, message: uiText("确定") });
    const translated = staticUiConfig(menu, "menu");
    expect(translated.selectedKeys).toBe(menu.selectedKeys);
    expect(translated.items[0].key).toBe("中文键");
    expect(translated.items[0].onClick).toBe(render);
    expect(translated.items[0].label).toBe(uiText("取消"));
});

test("admin semantic labels localize known enums and preserve unrecognized user content", async () => {
    expect(adminLabel("task.admin_cancelled")).toBe("任务：管理员取消");
    expect(adminLabel("小王的中文项目")).toBe("小王的中文项目");
    await setUiLocale("en-US");
    expect(adminLabel("active")).toBe(uiText("启用"));
    expect(adminLabel("小王的中文项目")).toBe("小王的中文项目");
    await setUiLocale("zh-CN");
    expect(adminLabel("task.admin_cancelled")).toBe("任务：管理员取消");
});
