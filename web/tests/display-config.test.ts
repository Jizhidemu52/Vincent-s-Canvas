import { expect, test } from "bun:test";
import { translateDisplayConfig } from "../src/lib/display-config";

test("display columns preserve source rows, identity columns, sorting and original callbacks", () => {
    const row = Object.freeze({ id: "中文编号", displayName: "中文姓名", prompt: "保留花纹" });
    const seen: unknown[][] = [], sorter = () => 0;
    const source = Object.freeze([
        Object.freeze({ title: "姓名", dataIndex: "displayName", sorter }),
        Object.freeze({ title: "编号", dataIndex: "id" }),
        Object.freeze({ title: "提示词", dataIndex: "prompt", render: (...args: unknown[]) => { seen.push(args); return String(args[0]); } }),
    ]);
    const display = translateDisplayConfig(source, "columns", text => `EN:${text}`);
    expect(display[0].title).toBe("EN:姓名");
    expect(display[0].sorter).toBe(sorter);
    expect(Reflect.apply((display[0] as any).render, undefined, [row.displayName, row, 0])).toBe("EN:中文姓名");
    expect((display[1] as any).render).toBeUndefined();
    expect(display[2].render!(row.prompt, row, 2)).toBe("EN:保留花纹");
    expect(seen).toEqual([[row.prompt, row, 2]]);
    expect(source[0].title).toBe("姓名");
    expect(row).toEqual({ id: "中文编号", displayName: "中文姓名", prompt: "保留花纹" });
});

test("option labels translate without changing filterable string type, values, keys, disablement or groups", () => {
    const callback = () => undefined;
    const source = Object.freeze([{ label: "部门", options: [{ value: "中文部门代码", label: "服装设计", disabled: true, onClick: callback }] }]);
    const display = translateDisplayConfig(source, "options", text => `EN:${text}`);
    expect(display[0].label).toBe("EN:部门");
    expect(display[0].options[0]).toMatchObject({ value: "中文部门代码", label: "EN:服装设计", disabled: true, onClick: callback });
    expect(source[0].options[0].label).toBe("服装设计");
});

test("render translation is lazy and can mount its own reactive display without translating hidden table pages", () => {
    const seen: string[] = [];
    const columns = translateDisplayConfig([{ dataIndex: "description" }, { dataIndex: "modelId" }], "columns", text => text, text => { seen.push(text); return { text }; });
    expect(seen).toEqual([]);
    expect((columns[0] as any).render("下一页原稿")).toEqual({ text: "下一页原稿" });
    expect(seen).toEqual(["下一页原稿"]);
    expect((columns[1] as any).render).toBeUndefined();
});
