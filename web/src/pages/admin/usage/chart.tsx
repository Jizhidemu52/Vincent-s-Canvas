import { useEffect, useRef } from "react";
import { theme } from "antd";
import * as echarts from "echarts/core";
import { BarChart, LineChart, HeatmapChart, ScatterChart, SankeyChart, BoxplotChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent, VisualMapComponent, AriaComponent, MarkLineComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";
echarts.use([BarChart, LineChart, HeatmapChart, ScatterChart, SankeyChart, BoxplotChart, GridComponent, TooltipComponent, LegendComponent, VisualMapComponent, AriaComponent, MarkLineComponent, CanvasRenderer]);
export default function UsageChart({ option, label, onSelect, height = 280 }: { option: EChartsOption; label: string; height?: number; onSelect?: (index: number, name: string) => void }) {
    const element = useRef<HTMLDivElement>(null),
        instance = useRef<echarts.ECharts | null>(null);
    const { token } = theme.useToken();
    const handler = useRef(onSelect);
    handler.current = onSelect;
    useEffect(() => {
        if (!element.current) return;
        const chart = echarts.init(element.current, undefined, { renderer: "canvas" });
        instance.current = chart;
        const observer = new ResizeObserver(() => chart.resize());
        observer.observe(element.current);
        chart.on("click", (params) => {
            if (params.componentType === "series" && typeof params.dataIndex === "number") handler.current?.(params.dataIndex, params.name);
        });
        return () => {
            observer.disconnect();
            chart.dispose();
            instance.current = null;
        };
    }, []);
    useEffect(() => {
        const axes = (input: EChartsOption["xAxis"] | EChartsOption["yAxis"]) =>
            input
                ? (Array.isArray(input) ? input : [input]).map((axis) => ({
                      ...axis,
                      axisLabel: { ...axis.axisLabel, color: token.colorTextSecondary },
                      axisLine: { ...axis.axisLine, lineStyle: { ...axis.axisLine?.lineStyle, color: token.colorBorderSecondary } },
                      splitLine: { ...axis.splitLine, lineStyle: { ...axis.splitLine?.lineStyle, color: token.colorBorderSecondary } },
                      nameTextStyle: { ...axis.nameTextStyle, color: token.colorTextSecondary },
                  }))
                : undefined;
        instance.current?.setOption(
            {
                animation: false,
                backgroundColor: token.colorBgContainer,
                color: [token.colorPrimary, token.colorSuccess, token.colorInfo, token.colorWarning, token.colorError],
                textStyle: { color: token.colorTextSecondary, fontFamily: token.fontFamily },
                aria: { enabled: true, label: { description: label } },
                tooltip: { trigger: "item", renderMode: "richText" },
                ...option,
                ...(option.xAxis ? { xAxis: axes(option.xAxis) } : {}),
                ...(option.yAxis ? { yAxis: axes(option.yAxis) } : {}),
                ...(option.legend && !Array.isArray(option.legend) ? { legend: { ...option.legend, textStyle: { color: token.colorTextSecondary } } } : {}),
                ...(option.visualMap && !Array.isArray(option.visualMap) ? { visualMap: { ...option.visualMap, textStyle: { color: token.colorTextSecondary }, inRange: { color: [token.colorFillSecondary, token.colorPrimary] } } } : {}),
            },
            { notMerge: true },
        );
    }, [option, token.colorBgContainer, token.colorPrimary, token.colorSuccess, token.colorInfo, token.colorWarning, token.colorError, token.colorTextSecondary, token.colorBorderSecondary, token.colorFillSecondary, token.fontFamily, label]);
    return <div ref={element} role="img" aria-label={label} data-usage-chart={label} style={{ height, width: "100%", minWidth: 0 }} />;
}
