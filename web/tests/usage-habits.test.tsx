import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UsageV2Profile, UsageV2Boards } from "../src/services/api/usage-analytics-v2";
import PersonProfile from "../src/pages/admin/usage/person-profile";
import Boards from "../src/pages/admin/usage/boards";
import { fixture } from "./usage-v2-browser/fixture";

test("profile displays observable habit denominators, missing references and board-separated parameters", () => {
    const data = fixture(new URL("http://localhost/api/admin/usage/people/test/profile")) as UsageV2Profile;
    const html = renderToStaticMarkup(<PersonProfile data={data} onBack={() => undefined} onPage={() => undefined} onDrilldown={() => undefined} onPrivateRecords={() => undefined} />);
    for (const label of ["已记录工作习惯", "批次关联任务占比", "有优化标记任务占比", "明确局部重绘任务占比", "提交的参考项数", "有效分母", "缺失 / 不适用", "常用参数记录 · 按板块", "不推断不同图片数"]) expect(html).toContain(label);
    expect(html).toContain("12.5%");
    expect(html).toContain("未记录 / 无有效值");
});

test("boards show same-board eligible and missing counts and use recorded-value share explicitly", () => {
    const data = fixture(new URL("http://localhost/api/admin/usage/boards")) as UsageV2Boards;
    const html = renderToStaticMarkup(<Boards data={data} onDrilldown={() => undefined} />);
    for (const label of ["已记录参数分布 · 按板块", "同板块任务", "有值任务", "缺失 / 不适用", "占有值任务", "75.0%", "未记录 / 无有效值", "不跨板块合并"]) expect(html).toContain(label);
});
