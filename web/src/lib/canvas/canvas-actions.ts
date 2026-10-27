/** One definition per canvas action. Context-specific targets stay in the owning callbacks. */
export const canvasActions = [
    { id: "undo", label: "撤销", key: "z" },
    { id: "redo", label: "重做", key: "z", shift: true },
    { id: "duplicate", label: "快速复制选中节点", contextLabel: "复制", key: "d" },
    { id: "delete", label: "删除选中", contextLabel: "删除", key: "Delete", plain: true },
    { id: "group", label: "创建款式组", key: "g" },
    { id: "selectAll", label: "全选节点", key: "a" },
    { id: "commands", label: "搜索命令、节点和素材", key: "k" },
    { id: "upload", label: "上传素材", contextLabel: "上传图片" },
    { id: "text", label: "添加文本", toolbarLabel: "文本" },
    { id: "image", label: "添加图片节点", toolbarLabel: "图片节点" },
    { id: "video", label: "添加视频节点", toolbarLabel: "视频节点" },
    { id: "audio", label: "添加音频节点", toolbarLabel: "音频节点" },
    { id: "config", label: "添加生成配置", toolbarLabel: "生成配置" },
    { id: "generate", label: "打开画布生图", toolbarLabel: "画布生图", contextLabel: "生成" },
    { id: "batch", label: "批量改图" },
    { id: "assets", label: "我的素材" },
    { id: "designTemplate", label: "使用设计模板" },
    { id: "compare", label: "对比图片" },
    { id: "resetView", label: "重置视图" },
    { id: "minimap", label: "切换小地图", toolbarLabel: "小地图" },
    { id: "export", label: "导出画布备份", toolbarLabel: "导出画布" },
    { id: "exportImages", label: "导出图片集 / PDF" },
    { id: "tools", label: "全部工具与板块", toolbarLabel: "全部工具" },
    { id: "guide", label: "重新查看新手引导" },
    { id: "theme", label: "切换主题" },
    { id: "rename", label: "重命名选中节点", contextLabel: "重命名" },
    { id: "clear", label: "清空画布" },
    { id: "select", label: "选择 / 框选", gesture: "选择工具 + 空白处拖动" },
    { id: "pan", label: "移动画布", gesture: "空格 + 拖动" },
    { id: "backgroundDots", label: "画布背景：点阵", toolbarLabel: "点阵" },
    { id: "backgroundLines", label: "画布背景：网格", toolbarLabel: "网格" },
    { id: "backgroundBlank", label: "画布背景：纯色", toolbarLabel: "纯色" },
    { id: "imageInfo", label: "显示图片信息" },
    { id: "home", label: "主页" },
    { id: "projects", label: "我的画布" },
    { id: "newProject", label: "新建画布" },
    { id: "deleteProject", label: "删除当前画布" },
    { id: "renameProject", label: "修改画布名称" },
    { id: "share", label: "复制画布链接" },
    { id: "shortcuts", label: "快捷键" },
    { id: "referenceImport", label: "网页参考图采集" },
] as const;
export type CanvasActionId = typeof canvasActions[number]["id"];
export type CanvasShortcutActionId = Extract<typeof canvasActions[number], { key: string }>["id"];
export function canvasActionLabel(id: CanvasActionId, surface: "toolbar" | "context" | "command" = "command", targetCount = 1) {
    const action = canvasActions.find(action => action.id === id)!;
    if (surface === "context" && targetCount > 1 && (id === "duplicate" || id === "delete")) return `${id === "duplicate" ? "复制" : "删除"}所选 ${targetCount} 项`;
    if (surface === "context" && "contextLabel" in action) return action.contextLabel;
    if (surface === "toolbar" && "toolbarLabel" in action) return action.toolbarLabel;
    return action.label;
}
type Shortcut = { id: string; key?: string; shift?: boolean; plain?: boolean };
type KeyEvent = { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean };
export function canvasActionShortcut(id: string) {
    const action: Shortcut | undefined = canvasActions.find(action => action.id === id);
    return !action?.key ? "" : action.plain ? "Delete / Backspace" : `Ctrl / Cmd + ${action.shift ? "Shift + " : ""}${action.key.toUpperCase()}`;
}
export function canvasActionHint(id: CanvasActionId) {
    const action = canvasActions.find(action => action.id === id)!;
    const shortcut = canvasActionShortcut(id) || ("gesture" in action ? action.gesture : "");
    return `${canvasActionLabel(id, "toolbar")}${shortcut ? `（${shortcut}）` : ""}`;
}
export function matchCanvasActionShortcut(event: KeyEvent): CanvasShortcutActionId | undefined {
    if (event.altKey) return;
    const modifier = Boolean(event.ctrlKey || event.metaKey);
    if (modifier && event.key.toLowerCase() === "y" && !event.shiftKey) return "redo";
    if (!modifier && !event.shiftKey && event.key === "Backspace") return "delete";
    return canvasActions.find(item => {
        const action: Shortcut = item;
        return action.key?.toLowerCase() === event.key.toLowerCase() && Boolean(action.shift) === Boolean(event.shiftKey) && Boolean(action.plain) !== modifier;
    })?.id as CanvasShortcutActionId | undefined;
}
export function canvasNodeKeyAction(event: KeyEvent): { x: number; y: number } | "edit" | null {
    if (event.ctrlKey || event.metaKey || event.altKey) return null;
    if (event.key === "Enter") return "edit";
    const distance = event.shiftKey ? 10 : 1;
    if (event.key === "ArrowLeft") return { x: -distance, y: 0 };
    if (event.key === "ArrowRight") return { x: distance, y: 0 };
    if (event.key === "ArrowUp") return { x: 0, y: -distance };
    if (event.key === "ArrowDown") return { x: 0, y: distance };
    return null;
}
