const words = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15 };

export function requestedGenerationCount(text) {
    const match = String(text).match(/(?:生成|生|出|给我)(?:出|成)?\s*([0-9]+|十[一二三四五]?|[一二两三四五六七八九])\s*(?:张(?:图(?:片)?)?|个视频|段视频)/u);
    if (!match) return null;
    const count = words[match[1]] || Number(match[1]);
    if (!Number.isInteger(count) || count < 1 || count > 15) throw new Error("每次可生成 1–15 个独立结果，请分批提交。");
    return count;
}

export function generationSlots(proposals, selectedIds, count) {
    if (!Number.isInteger(count) || count < 1 || count > 15) throw new Error("生成数量必须为 1–15。");
    const ids = [...new Set(selectedIds)];
    if (!ids.length || ids.length > count) throw new Error("生成数量不能少于选中方案数。");
    const selected = ids.map(id => proposals.find(proposal => proposal.id === id));
    if (selected.some(proposal => !proposal)) throw new Error("选中的方案已失效，请重新选择。");
    return Array.from({ length: count }, (_, index) => {
        const proposal = selected[index % selected.length];
        return { proposal, index, key: `${proposal.id}:output:${index}` };
    });
}
