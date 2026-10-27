import { canvasActions } from "./canvas-actions";

/** Loaded with discovery UI; the initial keyboard handler needs only bound shortcuts. */
export const canvasCommandCatalog = [
    { id: "upload", label: "上传素材", keywords: "导入 图片 视频 音频 import" },
    { id: "text", label: "添加文本", keywords: "文字 text" },
    { id: "image", label: "添加图片节点", keywords: "image" },
    { id: "video", label: "添加视频节点", keywords: "video" },
    { id: "audio", label: "添加音频节点", keywords: "audio" },
    { id: "config", label: "添加生成配置", keywords: "工作流 config" },
    { id: "generate", label: "打开画布生图", keywords: "生成 图片 prompt" },
    { id: "batch", label: "批量改图", keywords: "图片 batch" },
    ...canvasActions,
    { id: "assets", label: "我的素材", keywords: "素材库 asset" },
    { id: "designTemplate", label: "使用设计模板", keywords: "template" },
    { id: "compare", label: "对比图片", keywords: "compare" },
    { id: "resetView", label: "重置视图", keywords: "定位 居中 zoom" },
    { id: "minimap", label: "切换小地图", keywords: "导航 map" },
    { id: "export", label: "导出画布备份", keywords: "保存 备份 export" },
    { id: "tools", label: "全部工具与板块", keywords: "workspace" },
    { id: "guide", label: "重新查看新手引导", keywords: "教程 help" },
] as const;
