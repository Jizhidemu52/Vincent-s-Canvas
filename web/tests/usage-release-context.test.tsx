import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReleaseContext from "../src/pages/admin/usage/release-context";
import { publicationMarkLine } from "../src/pages/admin/usage/release-marks";
import type { UsageReleaseContext } from "../../shared/usage-release-context";
const publications: UsageReleaseContext = {
    source: "release_notes.published_at",
    scope: "global_publications_in_selected_dates",
    observedAt: "2026-10-03T00:00:00Z",
    limit: 200,
    truncated: true,
    releases: [
        {
            version: "v1.0.0",
            title: "<script>not executable</script>",
            day: "2026-10-02",
            publishedAt: "2026-10-01T16:00:00Z",
        },
        { version: "v1.0.1", title: "Second", day: "2026-10-02", publishedAt: "2026-10-01T18:00:00Z" },
    ],
};
test("release markers combine same-day publications and never claim deployment or version causality", () => {
    const marks = publicationMarkLine(publications.releases);
    expect(marks?.data).toEqual([{ name: "2026-10-02 · v1.0.0 / v1.0.1", xAxis: "2026-10-02" }]);
    const html = renderToStaticMarkup(
        <ReleaseContext publications={publications} from="2026-10-01T00:00:00+08:00" to="2026-10-03T00:00:00+08:00" />,
    );
    for (const text of [
        "不是部署时间",
        "不受部门或人员筛选影响",
        "控件与发布版本之间尚无明确映射",
        "最早 200 条",
        "北京时间",
        "2026/10/2",
    ])
        expect(html).toContain(text);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
});
test("omitted and empty publication sources remain distinguishable", () => {
    const props = { from: "2026-10-01T00:00:00+08:00", to: "2026-10-03T00:00:00+08:00" };
    expect(renderToStaticMarkup(<ReleaseContext {...props} />)).toContain("发布时间来源未返回");
    expect(
        renderToStaticMarkup(
            <ReleaseContext {...props} publications={{ ...publications, truncated: false, releases: [] }} />,
        ),
    ).toContain("本期未查到已发布更新日志");
});
