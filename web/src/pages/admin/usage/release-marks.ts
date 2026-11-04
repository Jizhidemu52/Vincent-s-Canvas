import type { LineSeriesOption } from "echarts";
import type { UsageReleaseAnnotation } from "../../../../../shared/usage-release-context";

export function publicationMarkLine(releases: UsageReleaseAnnotation[] = []): LineSeriesOption["markLine"] {
    const byDay = new Map<string, string[]>();
    for (const release of releases) byDay.set(release.day, [...(byDay.get(release.day) ?? []), release.version]);
    return {
        symbol: "none",
        label: { show: false },
        lineStyle: { type: "dashed", opacity: 0.5 },
        tooltip: { formatter: "更新日志发布时间（非部署时间） · {b}" },
        data: [...byDay].map(([day, versions]) => ({ name: `${day} · ${versions.join(" / ")}`, xAxis: day })),
    };
}
