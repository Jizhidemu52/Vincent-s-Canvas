import { expect, test } from "bun:test";
import type { EChartsOption } from "echarts";
import { displayChartOption } from "../src/pages/admin/usage/chart";

test("Chinese charts retain the exact option identity and never request translation", () => {
    const option: EChartsOption = { xAxis: { type: "category", data: ["开发组"] }, series: [{ type: "bar", name: "成果", data: [12] }] };
    expect(displayChartOption(option, () => { throw new Error("unexpected translation"); }, false)).toBe(option);
});

test("English formatters translate labels without modifying chart data, names or link identities", () => {
    const categories = ["开发组"], values = [{ name: "任务原名", value: 12 }], links = [{ source: "节点甲", target: "节点乙", value: 4 }];
    const option: EChartsOption = { xAxis: { type: "category", name: "团队", data: categories }, legend: { data: ["成果"] },
        series: [{ type: "bar", name: "成果", data: values }, { type: "sankey", data: [{ name: "节点甲" }, { name: "节点乙" }], links }] };
    const before = JSON.stringify(option), seen: string[] = [];
    const translations: Record<string, string> = { "开发组": "Development", "任务原名": "Original task", "团队": "Team", "成果": "Outputs", "节点甲": "Node A", "节点乙": "Node B" };
    const result = displayChartOption(option, text => { seen.push(text); return translations[text] ?? text; }, true) as any;
    expect(JSON.stringify(option)).toBe(before);
    expect(result.xAxis.data).toBe(categories);
    expect(result.xAxis.name).toBe("Team");
    expect(result.xAxis.axisLabel.formatter("开发组")).toBe("Development");
    expect(result.legend.data).toBe((option.legend as any).data);
    expect(result.legend.formatter("成果")).toBe("Outputs");
    expect(result.series[0].data).toBe(values);
    expect(result.series[0].name).toBe("成果");
    expect(result.series[1].links).toBe(links);
    expect(result.series[1].label.formatter({ name: "节点甲" })).toBe("Node A");
    const collected = [...seen];
    expect(result.tooltip.formatter({ name: "任务原名", seriesName: "成果", value: 12 })).toBe("Original task\nOutputs: 12");
    expect(result.tooltip.formatter([{ axisValueLabel: "开发组", seriesName: "成果", value: 12 }])).toBe("Development\nOutputs: 12");
    expect(seen).toEqual(collected); // A hover never queues a new model request.
});

test("existing custom formatters survive and mark-line templates keep original event names", () => {
    const formatter = () => "custom", line = { name: "版本发布", xAxis: "2026-11-01" };
    const option: EChartsOption = { tooltip: { formatter }, xAxis: { axisLabel: { formatter } }, legend: { formatter },
        series: [{ type: "line", data: [1], markLine: { tooltip: { formatter: "更新时间 · {b}" }, data: [line] } }] };
    const result = displayChartOption(option, text => ({ "更新时间 · {b}": "Updated · {b}", "版本发布": "Release" })[text] ?? text, true) as any;
    expect(result.tooltip.formatter).toBe(formatter);
    expect(result.xAxis.axisLabel.formatter).toBe(formatter);
    expect(result.legend.formatter).toBe(formatter);
    expect(result.series[0].markLine.data[0]).toBe(line);
    expect(result.series[0].markLine.tooltip.formatter({ name: "版本发布" })).toBe("Updated · Release");
});
