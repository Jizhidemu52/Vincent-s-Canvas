/** Illustrated examples for the free canvas. */
export const canvasExampleLessons = [
    {
        id: "view", number: "01", title: "导航与视图", product: "hat", productName: "帽子",
        scenario: "先把秋冬帽款参考板整理到好操作的位置",
        prepare: "一张针织帽原图。",
        action: "选中帽图，按 Shift+2 聚焦；按 H 拖动视野，按 V 回到选择。",
        result: "帽款进入合适的观看位置，便于查看翻边和针织细节。",
        location: "画布底部 → 选择、移动、缩放；左上菜单 → 搜索",
    },
    {
        id: "nodes", number: "02", title: "节点与素材", product: "bag", productName: "包包",
        scenario: "包身换麂皮、肩带皮革不变：分开记录原图与要求",
        prepare: "一张包款原图和“包身换麂皮，肩带不变”的要求。",
        action: "上传包图，添加文本节点写下要求，拖动节点排到一起。",
        result: "原图和修改要求并排放置，形成清楚的包款任务卡。",
        location: "画布底部 → 上传素材、文本、更多工具",
    },
    {
        id: "config", number: "03", title: "配置节点与参考角色", product: "knit", productName: "毛衫",
        scenario: "只参考围巾深蓝色，把毛衫改为海军蓝",
        prepare: "图1毛衫原图，图2围巾配色图。",
        action: "把两图连入配置，写“毛衫仅改海军蓝，围巾只参考颜色”，选择模型并生成。",
        result: "得到保留毛衫款式的海军蓝配色方案。",
        location: "生成配置节点 → 提示词、参考图、模型设置",
    },
    {
        id: "connections", number: "04", title: "连线与串行工作流", product: "womenswear", productName: "女装",
        scenario: "女装马甲原款 → 白底整理 → 3颗金色纽扣",
        prepare: "女装马甲原图和“白底整理”“换金色纽扣”两步要求。",
        action: "把原图连到白底配置，再连到金扣配置，点击运行工作流。",
        result: "先得到白底马甲，再以它为输入生成金扣版本。",
        location: "节点左右连接点 → 配置节点 → 运行工作流",
    },
    {
        id: "batch", number: "05", title: "批量处理围巾", product: "scarf", productName: "围巾",
        scenario: "围巾统一米白／深蓝格纹色组，各款独立出图",
        prepare: "三张围巾原图和统一米白、深蓝的改色要求。",
        action: "加入三张主图，选择逐图执行，写统一要求后生成。",
        result: "三张围巾各得到一张独立改色图。",
        location: "生成配置 → 逐图执行；更多工具 → 批量改图",
    },
    {
        id: "versions", number: "06", title: "原图、版本与任务记录", product: "menswear", productName: "男装",
        scenario: "男装 Polo 领口／袖口加细米白边，保留原款",
        prepare: "男装 Polo 原图及一张已生成的细边版本。",
        action: "打开生成档案查看原要求，点击基于此图继续，填写下一版修改。",
        result: "原图、当前版和下一版分别保留，便于比较与下载。",
        location: "选中结果图片 → AI 编辑 → 生成档案 / 基于此图继续",
    },
    {
        id: "local", number: "07", title: "图片编辑与局部改色", product: "hat", productName: "帽子",
        scenario: "准备针织帽翻边细节，再决定是否需要 AI 改色",
        prepare: "一张针织帽原图。",
        action: "用裁剪提取翻边细节；需要改色时打开局部重绘，涂选翻边并写“改为酒红”。",
        result: "得到翻边细节图或局部改色图。",
        location: "选中图片 → 更多图片工具 → 裁剪、编辑图片、局部重绘",
    },
    {
        id: "compare", number: "08", title: "对比、分组与排版", product: "bag", productName: "包包",
        scenario: "评审包身换麂皮，肩带皮革与五金是否保留",
        prepare: "包款原图和包身改为麂皮的版本。",
        action: "选择前后两图，切换并排、滑块或叠加对比，再将选定方案排成一组。",
        result: "清楚比较材质、肩带和五金变化，导出评审图。",
        location: "选中图片 → 更多图片工具 → 高级对比；多选 → 设计工具",
    },
    {
        id: "assistant", number: "09", title: "助手与当前图", product: "knit", productName: "毛衫",
        scenario: "先讨论毛衫要保留什么，再改一个细节",
        prepare: "选中一张毛衫图。",
        action: "打开对话，先问“换色需保留哪些细节”，再发送“仅改海军蓝，其余保持”。",
        result: "得到设计建议，并可继续围绕当前毛衫修改。",
        location: "画布 → 对话 → 当前作品 / 消息输入区",
    },
    {
        id: "delivery", number: "10", title: "交付与画布管理", product: "womenswear", productName: "女装",
        scenario: "把女装系列提案交给同事，同时保留可编辑备份",
        prepare: "命名整理好的女装单品图和提案说明。",
        action: "下载获选原图，导出图片集或 PDF，再导出画布备份。",
        result: "得到可沟通的提案文件和可继续编辑的画布备份。",
        location: "图片工具 → 下载；多选 → 导出图片集 / PDF；左上菜单 → 导出画布",
    },
] as const;

export type CanvasExampleLessonId = typeof canvasExampleLessons[number]["id"];
export const CANVAS_EXAMPLE_OVERVIEW_PREFIX = "canvas-example-overview-";
export const canvasExampleExtraPractices = [
    { lessonId: "connections", area: "branches", title: "一图多方案" },
    { lessonId: "batch", area: "shared", title: "共享配置" },
] as const;
export const canvasExampleNodePrefix = (id: CanvasExampleLessonId, area: "case" | "practice" | "branches" | "shared") => `canvas-example-${id}-${area}-`;
