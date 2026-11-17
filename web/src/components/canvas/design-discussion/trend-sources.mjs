export const TREND_SOURCES = [
    {
        title: "Première Vision｜AW 26–27 花型方向",
        url: "https://www.premierevision.com/en/articles/9c217379-4b87-f011-b482-000d3a204d71/aw-26-27-decodings-designs",
        date: "2025-09-24", checkedAt: "2026-11-17", scope: "2026/27 秋冬；展会花型方向，非所有品牌的固定风格",
        excerpt: "官方介绍了四类方向：借条格与传统织纹做视觉错动；用同色层次和留白表达细线植物；在深底上探索发光感花卉；以更新的配色与手绘/绣感表达重新解释传统挂毯纹样。它们是设计启发，不是本次客户已经确认的要求。",
    },
    {
        title: "Heuritech｜FW 27–28 材质与设计观察",
        url: "https://heuritech.com/articles/premiere-vision-fall-winter-27-28/",
        date: "2026-09-09", checkedAt: "2026-11-17", scope: "2027/28 秋冬；趋势机构的展会分析，以成人时装为主",
        excerpt: "报道强调材质的触感与不规则性、时间留下的表面层次，以及不张扬的舒适功能。自然方向可转译为生长感抽象纹理、非均匀色斑和留白；配色可探索有灰度和层次的中性色、紫色、酒红与绿色。具体品牌、童装适用性和生产工艺须结合本轮资料判断，不把报道方向直接当作事实结论。",
    },
];

export function selectedTrendSources(season = "") {
    return /2027|27.?28/.test(season) ? [TREND_SOURCES[1]] : /2026|26.?27/.test(season) ? [TREND_SOURCES[0]] : TREND_SOURCES;
}
