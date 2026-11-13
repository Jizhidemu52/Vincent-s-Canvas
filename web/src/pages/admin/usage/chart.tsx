import { useEffect, useRef } from "react";
import { theme } from "antd";
import * as echarts from "echarts/core";
import { BarChart, LineChart, HeatmapChart, ScatterChart, SankeyChart, BoxplotChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent, VisualMapComponent, AriaComponent, MarkLineComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";
import { useDisplayText } from "@/hooks/use-display-text";
import { useUiLocale } from "@/lib/i18n";
echarts.use([BarChart, LineChart, HeatmapChart, ScatterChart, SankeyChart, BoxplotChart, GridComponent, TooltipComponent, LegendComponent, VisualMapComponent, AriaComponent, MarkLineComponent, CanvasRenderer]);

type ChartRecord = Record<string, unknown>;
const chartRecord = (value: unknown): ChartRecord => value && typeof value === "object" && !Array.isArray(value) ? value as ChartRecord : {};
const chartList = (value: unknown) => Array.isArray(value) ? value : value ? [value] : [];
const chartMap = (value: unknown, map: (item: ChartRecord) => ChartRecord) => Array.isArray(value) ? value.map(item => map(chartRecord(item))) : map(chartRecord(value));

/** Translate presentation metadata only. Category/series/data/link identities
 * stay original so ECharts selection, legend state and drill-down keep working. */
export function displayChartOption(option: EChartsOption, translate: (text: string) => string, english: boolean): EChartsOption {
    if (!english) return option;
    const labels = new Map<string, string>();
    const collect = (value: unknown) => { if (typeof value === "string" && !labels.has(value)) labels.set(value, translate(value)); };
    const show = (value: unknown) => typeof value === "string" ? labels.get(value) ?? value : String(value ?? "");
    for (const axes of [option.xAxis, option.yAxis]) for (const item of chartList(axes)) {
        const axis = chartRecord(item);
        collect(axis.name);
        for (const category of chartList(axis.data)) collect(typeof category === "object" ? chartRecord(category).value : category);
    }
    for (const item of chartList(option.legend)) for (const entry of chartList(chartRecord(item).data)) collect(typeof entry === "object" ? chartRecord(entry).name : entry);
    for (const item of chartList(option.series)) {
        const series = chartRecord(item);
        collect(series.name);
        for (const point of chartList(series.data)) collect(chartRecord(point).name);
        const markLine = chartRecord(series.markLine);
        collect(chartRecord(markLine.tooltip).formatter);
        for (const point of chartList(markLine.data)) collect(chartRecord(point).name);
    }
    const axis = (value: ChartRecord) => ({
        ...value,
        ...(typeof value.name === "string" ? { name: show(value.name) } : {}),
        axisLabel: { ...chartRecord(value.axisLabel), ...(!chartRecord(value.axisLabel).formatter ? { formatter: show } : {}) },
    });
    const tooltip = (value: unknown) => {
        const original = chartRecord(value);
        if (original.formatter) return original;
        return { ...original, renderMode: "richText", formatter: (input: unknown) => {
            const rows = chartList(input).map(chartRecord);
            const first = rows[0] ?? {};
            const heading = show(first.axisValueLabel ?? first.name);
            return [heading, ...rows.map(row => {
                const values = Array.isArray(row.value) ? row.value : [row.value];
                const numbers = values.map(item => typeof item === "number" ? item.toLocaleString("en-US") : show(item)).join(", ");
                const seriesName = show(row.seriesName);
                return `${seriesName ? `${seriesName}: ` : ""}${numbers}`;
            })].filter(Boolean).join("\n");
        } };
    };
    const result: ChartRecord = { ...option, tooltip: tooltip(option.tooltip) };
    if (option.xAxis) result.xAxis = chartMap(option.xAxis, axis);
    if (option.yAxis) result.yAxis = chartMap(option.yAxis, axis);
    if (option.legend) result.legend = chartMap(option.legend, legend => ({ ...legend, ...(!legend.formatter ? { formatter: show } : {}) }));
    if (option.series) result.series = chartMap(option.series, series => {
        const markLine = chartRecord(series.markLine), lineTooltip = chartRecord(markLine.tooltip);
        return { ...series,
            ...(series.type === "sankey" && !chartRecord(series.label).formatter ? { label: { ...chartRecord(series.label), formatter: (params: unknown) => show(chartRecord(params).name) } } : {}),
            ...(typeof lineTooltip.formatter === "string" ? { markLine: { ...markLine, tooltip: { ...lineTooltip, formatter: (params: unknown) => show(lineTooltip.formatter).replace("{b}", show(chartRecord(params).name)) } } } : {}),
        };
    });
    return result as EChartsOption;
}

export default function UsageChart({ option, label, onSelect, height = 280 }: { option: EChartsOption; label: string; height?: number; onSelect?: (index: number, name: string) => void }) {
    const translate = useDisplayText();
    const locale = useUiLocale();
    // Collection occurs while rendering, not from ECharts' later callbacks.
    const displayed = useRef(option);
    displayed.current = displayChartOption(option, translate, locale === "en-US");
    const displayLabel = translate(label);
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
        const option = displayed.current;
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
                aria: { enabled: true, label: { description: displayLabel } },
                tooltip: { trigger: "item", renderMode: "richText" },
                ...option,
                ...(option.xAxis ? { xAxis: axes(option.xAxis) } : {}),
                ...(option.yAxis ? { yAxis: axes(option.yAxis) } : {}),
                ...(option.legend && !Array.isArray(option.legend) ? { legend: { ...option.legend, textStyle: { color: token.colorTextSecondary } } } : {}),
                ...(option.visualMap && !Array.isArray(option.visualMap) ? { visualMap: { ...option.visualMap, textStyle: { color: token.colorTextSecondary }, inRange: { color: [token.colorFillSecondary, token.colorPrimary] } } } : {}),
            },
            { notMerge: true },
        );
    }, [option, translate, locale, token.colorBgContainer, token.colorPrimary, token.colorSuccess, token.colorInfo, token.colorWarning, token.colorError, token.colorTextSecondary, token.colorBorderSecondary, token.colorFillSecondary, token.fontFamily, displayLabel]);
    return <div ref={element} role="img" aria-label={displayLabel} data-usage-chart={label} style={{ height, width: "100%", minWidth: 0 }} />;
}
