import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UsageV2Models } from "../src/services/api/usage-analytics-v2";
import Models from "../src/pages/admin/usage/models";
import { fixture } from "./usage-v2-browser/fixture";
test("models show five-number samples, timing gaps, classified failures and current cost breakdown", () => {
    const data = fixture(new URL("http://localhost/api/admin/usage/models")) as UsageV2Models;
    const html = renderToStaticMarkup(<Models data={data} onDrilldown={() => undefined} />);
    for (const label of ["模型端到端耗时 · 五数分布", "成功任务", "有效耗时", "缺失耗时", "P25 ms", "P75 ms", "最小 ms", "最大 ms", "供应商超时 3", "当前成本维度明细", "不平均每日分位数"]) expect(html).toContain(label);
});
