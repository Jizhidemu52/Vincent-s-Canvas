import { canvasActions, type CanvasActionId } from "./canvas-actions";

// Search aliases are loaded only when discovery opens. Labels, ids and shortcuts
// still come from the exact definitions used by menus and keyboard handling.
const searchAliases: Partial<Record<CanvasActionId, string>> = {
    group: "分组", commands: "command search", upload: "导入 图片 视频 音频 import",
    text: "文字", config: "工作流", generate: "生成 图片 prompt", batch: "图片",
    assets: "素材库 asset", designTemplate: "template", resetView: "定位 居中 zoom",
    minimap: "导航 map", export: "保存 备份", exportImages: "export images",
    tools: "workspace", guide: "教程 help", theme: "深色 浅色 dark light",
    rename: "名称", clear: "清除", select: "选择工具", pan: "手形 平移 hand",
    imageInfo: "隐藏 图片名称 info", projects: "项目", newProject: "新项目 new project",
    deleteProject: "delete project", renameProject: "重命名 rename project", share: "分享 share link",
    shortcuts: "键盘 keyboard", referenceImport: "网站 浏览器 import web",
};
export const canvasCommandCatalog = canvasActions.map(action => ({ ...action, keywords: `${action.id} ${searchAliases[action.id] || ""}` }));

export function filterCanvasCommands<T extends { label: string; keywords?: string; enabled?: boolean }>(items: readonly T[], query: string): T[] {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter(item => item.enabled !== false && terms.every(term => `${item.label} ${item.keywords || ""}`.toLowerCase().includes(term)));
}
