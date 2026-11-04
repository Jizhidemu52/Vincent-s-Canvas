import { useState } from "react";
import { Select } from "antd";
import type { UsageControlDaily, UsageReleaseContext } from "../../../../../shared/usage-release-context";
import { ChartPanel } from "./components";
import { alignDailyTrend } from "./format";
import { publicationMarkLine } from "./release-marks";

export default function ReleaseContext({
    publications,
    controls,
    from,
    to,
}: {
    publications?: UsageReleaseContext;
    controls?: UsageControlDaily;
    from: string;
    to: string;
}) {
    const [selected, setSelected] = useState("");
    const key = (row: NonNullable<UsageControlDaily>["series"][number]) =>
        JSON.stringify([row.boardKey, row.controlKey]);
    const row = controls?.series.find((row) => key(row) === selected) ?? controls?.series[0];
    const points = alignDailyTrend([], [], from, to),
        counts = new Map(row?.daily.map((point) => [point.day, point.count]) ?? []);
    return (
        <section className="space-y-4" aria-label="发布日志与控件趋势">
            <div className="wb-surface min-w-0 p-4 sm:p-5">
                <h3 className="font-semibold">更新日志发布时间注记</h3>
                <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
                    虚线来自全站已发布日志的
                    published_at，仅按本期日期选择，不受部门或人员筛选影响；不是部署时间、员工加载版本或功能生效时间，不能据此判断版本效果。控件与发布版本之间尚无明确映射。
                </p>
                {!publications ? (
                    <p className="mt-2 text-sm">发布时间来源未返回，不能推断为没有发布。</p>
                ) : !publications.releases.length ? (
                    <p className="mt-2 text-sm">本期未查到已发布更新日志。</p>
                ) : (
                    <ul className="mt-3 max-h-48 space-y-2 overflow-auto text-xs">
                        {publications.releases.map((note) => (
                            <li key={note.version} className="break-words">
                                <time dateTime={note.publishedAt}>
                                    {new Date(note.publishedAt).toLocaleString("zh-CN", {
                                        timeZone: "Asia/Shanghai",
                                        hour12: false,
                                    })}
                                </time>
                                （北京时间） · {note.version} · {note.title}
                            </li>
                        ))}
                    </ul>
                )}
                {publications?.truncated ? (
                    <p role="status" className="mt-2 text-xs">
                        此范围只显示最早 200 条发布日志，后续未展示；请缩短日期查看。
                    </p>
                ) : null}
            </div>
            <ChartPanel
                title="控件已记录使用趋势"
                description="来自同一筛选范围的旧 usage_events，不新增采集；按板块＋控件键区分，排除访问与采集缺口事件，其他动作按事件条数计。无记录日期留空，不表示未使用；结构控件不能当成功能名称，曲线变化不证明版本因果。"
                option={
                    row
                        ? {
                              tooltip: { trigger: "axis", renderMode: "richText" },
                              grid: { left: 12, right: 20, top: 20, bottom: 30, containLabel: true },
                              xAxis: { type: "category", data: points.map((point) => point.day) },
                              yAxis: { type: "value", minInterval: 1 },
                              series: [
                                  {
                                      type: "line",
                                      name: `${row.boardLabel} · ${row.label}`,
                                      data: points.map((point) => counts.get(point.day) ?? null),
                                      connectNulls: false,
                                      markLine: publicationMarkLine(publications?.releases),
                                  },
                              ],
                          }
                        : undefined
                }
            >
                {row ? (
                    <Select
                        className="mt-2 w-full"
                        aria-label="控件趋势选择"
                        value={key(row)}
                        onChange={setSelected}
                        options={controls?.series.map((item) => ({
                            value: key(item),
                            label: `${item.boardLabel} · ${item.label} · ${item.total} 条`,
                        }))}
                    />
                ) : null}
                <p className="mt-2 text-xs">
                    名称映射：现有控件键与登记标签，不从页面文字或更新日志猜测。
                    {controls
                        ? `共 ${controls.totalControls} 个板块／控件组合，缺少控件键的操作记录 ${controls.missingControlRecords} 条。`
                        : "控件统计未返回。"}
                    {controls?.truncated ? "仅展示记录数最多的 20 个组合，其余未展示；请缩小筛选。" : ""}
                </p>
                {row ? (
                    <details className="mt-2 text-xs">
                        <summary className="cursor-pointer">已记录日的准确计数</summary>
                        <p className="mt-2 break-all">
                            板块：{row.boardKey}；控件：{row.controlKey}
                        </p>
                        <ul className="mt-2 max-h-40 overflow-auto">
                            {row.daily.map((point) => (
                                <li key={point.day}>
                                    {point.day} · {point.count} 条
                                </li>
                            ))}
                        </ul>
                    </details>
                ) : null}
            </ChartPanel>
        </section>
    );
}
