/** Static practice records only. Never inserted into user history, totals, tasks, assets or drafts. */
type DesignExampleMedia = { src: string; label: string; alt: string } & (
    { kind?: "image" } | { kind: "video"; poster: string; downloadSrc?: string }
);

export type DesignExample = {
    id: string;
    title: string;
    category: string;
    purpose: string;
    location: string;
    media: DesignExampleMedia[];
    steps: Array<{ title: string; detail: string }>;
    prompt?: string;
};

const asset = (name: string, label: string) => ({ src: `/design-examples/${name}.webp`, label, alt: label });
const pair = (name: string, before: string, after: string) => [asset(`${name}-source`, before), asset(name, after)];
const example = (id: string, content: Omit<DesignExample, "id">): DesignExample => ({ id, ...content });

export const designExamples: Record<string, DesignExample> = {
    image: example("image", {
        title: "图像生成 · 文字生成马甲图", category: "女装",
        purpose: "把文字要求变成款式图。", location: "左侧导航 → 图像生成",
        media: [asset("womenswear-source", "结果示意 · 灰褐色三扣马甲")],
        steps: [
            { title: "输入", detail: "一段明确的马甲款式要求。" },
            { title: "操作", detail: "填写“图像提示词”，选择模型，点击“开始生成”。" },
            { title: "结果", detail: "得到马甲款式图。" },
        ],
        prompt: "设计一件 Zara 风格的成女通勤马甲：灰褐色哑光西装料，清晰 V 领，无袖，轻收腰，中臀长度，前中三颗同色纽扣，左右各一个嵌线袋。正面完整白底商品图，不加品牌文字，不搭配其他服装。",
    }),
    "image-edit": example("image-edit", {
        title: "图片编辑 · 包身换成麂皮", category: "包包",
        purpose: "按要求修改已有图片。", location: "左侧导航 → 图片编辑",
        media: pair("bag", "输入 · 皮革包原图", "结果示意 · 麂皮包身"),
        steps: [
            { title: "输入", detail: "包包原图和包身换麂皮的要求。" },
            { title: "操作", detail: "上传图片、填写要求，选择模型，点击“开始编辑”。" },
            { title: "结果", detail: "得到麂皮包身的改款图。" },
        ],
        prompt: "仅将包身大面片改为深巧克力色细绒麂皮，保留原包型、尺寸比例和接缝位置。肩带继续使用原皮革，金属环扣、背景、角度与光影不变。不加口袋、文字或装饰。",
    }),
    "detail-enhance": example("detail-enhance", {
        title: "细节增强 · 看清毛衫针路", category: "毛衫",
        purpose: "增强图片中的材质与细节。", location: "左侧导航 → 细节增强",
        media: [asset("knit-source", "输入 · 燕麦色圆领毛衫")],
        steps: [
            { title: "输入", detail: "毛衫原图和需要增强的针织细节。" },
            { title: "操作", detail: "上传图片、填写要求，选择模型，点击“开始增强”。" },
            { title: "结果", detail: "得到细节更清楚的毛衫展示图。" },
        ],
        prompt: "增强这件燕麦色圆领毛衫的针织纹理、领口、袖口和下摆细节，保留原款轮廓、针路方向、罗纹范围与配色，不增加图案或装饰。",
    }),
    "angle-control": example("angle-control", {
        title: "角度控制 · 补包包侧视图", category: "包包",
        purpose: "为同一产品生成其他视角。", location: "左侧导航 → 角度控制",
        media: [asset("bag-source", "输入 · 包包正面"), asset("bag-angle", "结果示意 · 侧向视角")],
        steps: [
            { title: "输入", detail: "包包原图和左前方45度视角要求。" },
            { title: "操作", detail: "上传图片、填写视角，选择模型，点击“生成角度图”。" },
            { title: "结果", detail: "得到包包侧向视图。" },
        ],
        prompt: "将参考包包呈现为左前方 45 度的三分之二侧视图，展示包身厚度、侧缝及肩带连接，保留包型、皮革材质、颜色与金属环扣，完整白底商品图。",
    }),
    "seamless-stitch": example("seamless-stitch", {
        title: "无缝拼接 · 格纹接成连续图", category: "围巾",
        purpose: "将图案接成连续花型。", location: "左侧导航 → 无缝拼接",
        media: [asset("pattern-source", "输入 · 驼棕格纹单元")],
        steps: [
            { title: "输入", detail: "一张驼棕格纹平面图。" },
            { title: "操作", detail: "上传图片，选择模型，点击“开始无缝拼接”。" },
            { title: "结果", detail: "得到格纹连续图案。" },
        ],
    }),
    "midjourney-blend": example("midjourney-blend", {
        title: "MJ 多图融合 · 马甲结构融合针织质感", category: "女装 × 毛衫",
        purpose: "融合多张参考图的视觉特点。", location: "左侧导航 → MJ 多图融合",
        media: [asset("womenswear-source", "输入一 · 马甲结构"), asset("knit-source", "输入二 · 针织肌理")],
        steps: [
            { title: "输入", detail: "马甲结构图和毛衫质感图。" },
            { title: "操作", detail: "上传两张参考，选择速度和布局，点击“开始融合”。" },
            { title: "结果", detail: "得到融合两张参考的款式图。" },
        ],
    }),
    video: example("video", {
        title: "视频生成 · 模特自然展示毛衫", category: "毛衫",
        purpose: "展示衣服整体与领口、肩线和针织细节。", location: "左侧导航 → 视频生成",
        media: [asset("model-natural-source", "输入 · 模特毛衫参考帧"), {
            kind: "video", src: "/design-examples/model-natural-showcase.mp4", poster: "/design-examples/model-natural-source.webp",
            downloadSrc: "/design-examples/model-natural-showcase-original.mp4",
            label: "结果视频 · 模特自然展示与细节", alt: "模特以正常真人速度展示毛衫，镜头连续推近领口、肩线与针织细节",
        }],
        steps: [
            { title: "输入", detail: "模特毛衫参考图与正常速度展示、拉近细节的要求。" },
            { title: "操作", detail: "上传参考图，填写要求，选择10秒、1080p并关闭声音后点击“生成视频”。" },
            { title: "结果", detail: "模特自然侧身展示衣服，随后镜头连续推近领口、肩线与针织细节。" },
        ],
        prompt: "以参考图中的模特和毛衫为准，保持人物身份、衣服款式、配色、领口、肩线与针织纹理不变。10秒连续镜头，1080p，静音。前半段模特以正常真人速度从正面自然侧身再回正，展示衣服整体；后半段镜头连续平稳推近领口、肩线和针织细节。不慢放人物，不突然切镜，不遮挡衣服，不改变服装结构，不添加文字。",
    }),
    "gpt-chat": example("gpt-chat", {
        title: "对话改图 · 帽子翻边换颜色", category: "帽子",
        purpose: "通过对话持续修改图片。", location: "左侧导航 → 对话改图",
        media: pair("hat", "输入 · 燕麦色针织帽", "结果示意 · 酒红翻边"),
        steps: [
            { title: "输入", detail: "帽子原图和翻边改酒红的要求。" },
            { title: "操作", detail: "上传图片、填写要求，点击“发送”。" },
            { title: "结果", detail: "得到酒红翻边的帽子改色图。" },
        ],
        prompt: "只把当前这顶帽子的翻边改为低饱和酒红色，帽顶仍为原燕麦色；帽高、翻边宽度、罗纹走向、纱线质感、角度和背景全部保持不变，不加装饰。",
    }),
    "creative-text-to-style": example("creative-text-to-style", {
        title: "以文生款 · 灰褐色通勤马甲", category: "女装",
        purpose: "把款式描述变成服装设计图。", location: "创意设计 → 以文生款",
        media: [asset("womenswear-source", "结果示意 · 三扣 V 领马甲")],
        steps: [
            { title: "输入", detail: "一段明确的马甲款式要求。" },
            { title: "操作", detail: "填写“款式描述”，选择模型，点击“生成款式”。" },
            { title: "结果", detail: "得到马甲款式图。" },
        ],
        prompt: "成女通勤系列马甲，灰褐色哑光西装料，V 领，无袖，轻收腰，中臀长度，前中三颗同色纽扣，左右嵌线袋，正面完整白底商品图。简洁都市感，无品牌文字。",
    }),
    "creative-style-to-sketch": example("creative-style-to-sketch", {
        title: "款生线稿 · 毛衫照片转线稿", category: "毛衫",
        purpose: "把款式照片整理成结构线稿。", location: "创意设计 → 款生线稿",
        media: [asset("knit-source", "输入 · 圆领毛衫"), asset("knit-sketch", "结果示意 · 结构线稿")],
        steps: [
            { title: "输入", detail: "一张正面完整的毛衫照片。" },
            { title: "操作", detail: "上传照片，选择线条风格和模型，点击“生成线稿”。" },
            { title: "结果", detail: "得到毛衫结构线稿。" },
        ],
        prompt: "整理为白底黑线的正面毛衫款式线稿，保留圆领、落肩、袖长、衣长与领口袖口下摆的罗纹范围。不增加图案，不推测背面，不标注虚构尺寸。",
    }),
    "creative-virtual-try-on": example("creative-virtual-try-on", {
        title: "虚拟试穿 · 单件毛衫操作示例", category: "毛衫",
        purpose: "将一件产品的设计带到成人模特上，先确认产品与模特的参考角色。", location: "创意设计 → 虚拟试穿",
        media: [asset("knit-source", "输入示意 · 毛衫产品图"), asset("model-natural-source", "可选输入示意 · 成人模特与姿态")],
        steps: [
            { title: "输入", detail: "上传一件毛衫，并选择上传成人模特图或填写成人模特描述。" },
            { title: "操作", detail: "填写需保持的领型、绞花与罗纹，确认参考角色后点击“生成设计”，上传不会自动生成。" },
            { title: "结果", detail: "此处仅为输入示意而非实测结果，实际输出需核对衣物结构与身体关系，不保证身份或真实合身度。" },
        ],
    }),
    "creative-sketch-to-photo": example("creative-sketch-to-photo", {
        title: "线稿转实拍 · 毛衫材质与配色示例", category: "毛衫",
        purpose: "按线稿结构生成指定材质和颜色的实拍质感效果。", location: "创意设计 → 线稿转实拍",
        media: [asset("knit-sketch", "输入示意 · 毛衫结构线稿"), asset("knit-source", "可选输入示意 · 针织材质与配色")],
        steps: [
            { title: "输入", detail: "上传线稿图，可选添加只提供材质与配色的参考图。" },
            { title: "操作", detail: "明确填写材质方向、颜色方向与需保持的细节，选择展示方式后点击“生成设计”。" },
            { title: "结果", detail: "此处仅为输入示意而非实测结果，黑白线稿没有原色信息，生成图不能当作原色还原或生产工艺验证。" },
        ],
    }),
    "creative-local-restyle": example("creative-local-restyle", {
        title: "局部改款 · 马甲换金属扣", category: "女装",
        purpose: "修改服装的指定细节。", location: "创意设计 → 局部改款",
        media: pair("womenswear", "输入 · 三颗同色扣马甲", "结果示意 · 哑光金属扣"),
        steps: [
            { title: "输入", detail: "马甲原图和三颗纽扣换金属扣的要求。" },
            { title: "操作", detail: "上传图片、填写改动要求，选择模型，点击“生成设计”。" },
            { title: "结果", detail: "得到金属扣马甲改款图。" },
        ],
        prompt: "仅将原款前中三颗棕色纽扣替换为同直径、同位置的哑光仿古金色圆形金属扣。保留灰褐色面料、V 领、门襟、口袋、衣长和全部缝线，不增加第四颗扣。",
    }),
    "creative-garment-colorway": example("creative-garment-colorway", {
        title: "服装配色 · 毛衫改海军蓝", category: "毛衫",
        purpose: "为同一服装尝试不同配色。", location: "创意设计 → 服装配色",
        media: pair("knit", "输入 · 燕麦色毛衫", "结果示意 · 海军蓝"),
        steps: [
            { title: "输入", detail: "毛衫原图和海军蓝目标色。" },
            { title: "操作", detail: "上传图片、填写“目标色板”，选择模型，点击“生成设计”。" },
            { title: "结果", detail: "得到海军蓝毛衫配色图。" },
        ],
        prompt: "仅将整件毛衫调整为低饱和深海军蓝，保留原圆领、落肩、袖长、衣长、罗纹宽度、针织肌理和背景。不添加图案，不改变纱线粗细。",
    }),
    "creative-back-design": example("creative-back-design", {
        title: "背面设计 · 针织 Polo 补背面", category: "男装",
        purpose: "根据正面图设计服装背面。", location: "创意设计 → 背面设计",
        media: [asset("menswear-source", "输入 · 男装 Polo 正面"), asset("menswear-back", "结果示意 · 背面方案")],
        steps: [
            { title: "输入", detail: "针织Polo正面图和简洁背面要求。" },
            { title: "操作", detail: "上传图片、选择背面结构，选择模型，点击“生成设计”。" },
            { title: "结果", detail: "得到针织Polo背面设计图。" },
        ],
        prompt: "为这件海军蓝长袖针织 Polo 设计简洁背面，保留同一领型、针织质感、袖长、衣长及袖口下摆罗纹比例。背面无纽扣门襟、无图案、无品牌字样。正后方完整白底商品视图。",
    }),
    "creative-pattern-extract": example("creative-pattern-extract", {
        title: "花型提取 · 围巾照片提取格纹", category: "围巾",
        purpose: "从商品照片中提取平面花型。", location: "创意设计 → 花型提取",
        media: [asset("scarf-source", "输入 · 格纹围巾"), asset("pattern-source", "结果示意 · 平面格纹")],
        steps: [
            { title: "输入", detail: "一张格纹清楚的围巾照片。" },
            { title: "操作", detail: "上传照片、选择提取范围，选择模型，点击“生成图案”。" },
            { title: "结果", detail: "得到平面格纹图。" },
        ],
        prompt: "从这条围巾中整理清楚可见的驼色底、棕色细窗格纹，去除围巾轮廓、流苏、阴影和褶皱，平展为正视平面图案参考，保持疏朗格线比例，不新增装饰或文字。",
    }),
    "creative-pattern-colorway": example("creative-pattern-colorway", {
        title: "图案配色 · 格纹换成米白海军蓝", category: "围巾",
        purpose: "为同一花型更换颜色。", location: "创意设计 → 图案配色",
        media: [asset("pattern-source", "输入 · 驼棕格纹"), asset("pattern", "结果示意 · 米白海军蓝格纹")],
        steps: [
            { title: "输入", detail: "格纹原图和米白、海军蓝两种目标色。" },
            { title: "操作", detail: "上传图案、填写“目标色板”，选择模型，点击“生成设计”。" },
            { title: "结果", detail: "得到米白海军蓝格纹配色图。" },
        ],
        prompt: "保留格纹线条的形状、粗细、间距和排列，仅把驼色底改为柔和米白、棕色格线改为深海军蓝。不新增格线，不移动图案，不增加纹理或阴影。",
    }),
    "creative-pattern-craft": example("creative-pattern-craft", {
        title: "图案工艺 · 格纹呈现提花质感", category: "围巾",
        purpose: "预览图案的刺绣、提花等工艺效果。", location: "创意设计 → 图案工艺",
        media: [asset("pattern-source", "输入 · 平面格纹"), asset("pattern-craft", "结果示意 · 毛感提花质感")],
        steps: [
            { title: "输入", detail: "一张驼棕格纹平面图。" },
            { title: "操作", detail: "上传图案，选择“提花”和“毛呢”，点击“生成设计”。" },
            { title: "结果", detail: "得到毛感提花效果图。" },
        ],
        prompt: "将这份驼棕格纹表现为柔软毛感围巾面料的提花观感，保持格线比例、位置与两色关系，细腻织物肌理，不加刺绣边框，不把格线做成突起绳条。正视平铺材质样片。",
    }),
    "creative-accessory-design": example("creative-accessory-design", {
        title: "辅料设计 · 几何纹样拉链头", category: "包包",
        purpose: "将图案应用到服装或包款辅料。", location: "创意设计 → 辅料设计",
        media: [asset("hardware-source", "输入一 · 拉链头结构"), { src: "/design-examples/diamond-mark.svg", label: "输入二 · 菱形线条", alt: "简洁菱形线条纹样" }, asset("hardware", "结果示意 · 几何压纹拉链头")],
        steps: [
            { title: "输入", detail: "拉链头结构图和菱形纹样图。" },
            { title: "操作", detail: "上传两张图，选择“拉链头”和“仅表面纹样”，点击“生成设计”。" },
            { title: "结果", detail: "得到几何压纹拉链头设计图。" },
        ],
        prompt: "图片一负责金属拉链头结构、连接孔位和圆角轮廓；图片二只提供菱形线条。把纹样做成正面浅压纹，保留连接孔畅通，哑光仿古金属质感，不加品牌文字，不改变拉链头外形。",
    }),
    "pattern-placement": example("pattern-placement", {
        title: "图案定位 · 菱形放到帽子翻边", category: "帽子",
        purpose: "定位图案后生成产品效果图。", location: "创意设计 → 图案定位",
        media: [asset("hat-source", "输入 · 针织帽底图"), { src: "/design-examples/diamond-mark.svg", label: "输入 · 菱形纹样", alt: "用于帽子翻边定位的菱形线条" }],
        steps: [
            { title: "输入", detail: "针织帽底图和菱形纹样。" },
            { title: "操作", detail: "调整图案位置，点击“生成 AI 效果图”，在图片编辑中点“开始编辑”。" },
            { title: "结果", detail: "得到按定位要求生成的帽子效果图。" },
        ],
    }),
    "pattern-repeat": example("pattern-repeat", {
        title: "花型循环 · 菱形重复排列", category: "围巾",
        purpose: "把单个纹样排列成连续花型。", location: "创意设计 → 花型循环",
        media: [{ src: "/design-examples/diamond-mark.svg", label: "输入 · 菱形纹样", alt: "用于重复排列的菱形线条" }, asset("scarf-source", "款式参考 · 围巾比例")],
        steps: [
            { title: "输入", detail: "一枚独立的菱形纹样。" },
            { title: "操作", detail: "添加纹样、调整疏密与排列，点击“导出无缝周期 PNG”。" },
            { title: "结果", detail: "得到可重复排列的花型周期图。" },
        ],
    }),
    "series-recipe": example("series-recipe", {
        title: "系列配方 · 毛衫做三个色组", category: "毛衫",
        purpose: "从同一参考展开系列设计方案。", location: "创意设计 → 系列配方",
        media: pair("knit", "输入 · 燕麦色毛衫", "结果示意 · 海军蓝方案"),
        steps: [
            { title: "输入", detail: "毛衫原图和海军蓝、酒红、鼠尾草绿三种颜色。" },
            { title: "操作", detail: "配置“系列配色”和三个分支，选择模型，点击“运行配方”。" },
            { title: "结果", detail: "得到三组毛衫配色候选图。" },
        ],
        prompt: "以同一件毛衫为基准，各分支只改变明确指定的颜色。共同保留圆领、落肩、袖长、衣长、罗纹范围和针织肌理，不添加图案。",
    }),
    prompts: example("prompts", {
        title: "提示词库 · 复用帽子改色要求", category: "帽子",
        purpose: "查找并复用现成提示词。", location: "左侧导航 → 提示词库",
        media: pair("hat", "输入参考 · 燕麦色针织帽", "目标方向 · 酒红翻边"),
        steps: [
            { title: "输入", detail: "针织帽翻边改酒红的要求。" },
            { title: "操作", detail: "搜索并复制合适的提示词，替换为当前帽款和颜色。" },
            { title: "结果", detail: "得到一段可用的帽子改色提示词。" },
        ],
        prompt: "仅将当前针织帽的翻边改为低饱和酒红色，帽顶仍为燕麦色；帽高、翻边宽度、针织纹理、角度和背景保持不变，不加装饰。",
    }),
    "my-prompts": example("my-prompts", {
        title: "我的提示词 · 保存毛衫改色模板", category: "毛衫",
        purpose: "保存和复用自己的提示词模板。", location: "左侧导航 → 我的提示词",
        media: pair("knit", "输入参考 · 燕麦色毛衫", "目标方向 · 海军蓝"),
        steps: [
            { title: "输入", detail: "一段毛衫改色提示词。" },
            { title: "操作", detail: "点击“新建模板”，填写名称、分类和内容并保存。" },
            { title: "结果", detail: "得到可复用的个人提示词模板。" },
        ],
        prompt: "对【当前原款】仅将【目标区域】改为【目标颜色】；保留【版型、领口、袖口、下摆、图案位置、面料纹理】及原背景。不要增加未要求的装饰。使用前请替换所有占位项。",
    }),
    assets: example("assets", {
        title: "素材库 · 整理包款原图与改款", category: "包包",
        purpose: "集中保存和查找设计图片。", location: "左侧导航 → 素材库",
        media: pair("bag", "输入 · 皮革包原图", "输入 · 麂皮改款方案"),
        steps: [
            { title: "输入", detail: "包款原图和改款图。" },
            { title: "操作", detail: "点击“上传图片”，填写标题和标签。" },
            { title: "结果", detail: "得到方便查找和复用的包款素材。" },
        ],
    }),
    "design-library": example("design-library", {
        title: "设计灵感库 · 分享系列方向", category: "男装 × 帽子 × 围巾",
        purpose: "向同事分享设计图片和思路。", location: "左侧导航 → 设计灵感库",
        media: [asset("menswear", "系列方向 · 男装细撞色边"), asset("hat", "系列方向 · 帽子局部配色"), asset("scarf", "系列方向 · 米白深蓝围巾")],
        steps: [
            { title: "输入", detail: "系列图片、标题和设计思路。" },
            { title: "操作", detail: "点击“分享我的设计”，添加内容并点击“确认公开并发布”。" },
            { title: "结果", detail: "得到同事可查看的系列分享。" },
        ],
    }),
    "reference-import": example("reference-import", {
        title: "网页采集 · 收集围巾参考图", category: "围巾",
        purpose: "从网页收集图片到素材库。", location: "素材库 → 网页采集",
        media: [asset("scarf-source", "采集方向 · 驼棕格纹围巾"), asset("scarf", "采集方向 · 米白海军蓝")],
        steps: [
            { title: "输入", detail: "一个围巾产品网页链接。" },
            { title: "操作", detail: "点击“采集网页图片”，勾选图片并“读取所选”，再“确认导入”。" },
            { title: "结果", detail: "在素材库得到带来源链接的围巾参考图。" },
        ],
    }),
};

const imageTools = new Set(["image", "detail-enhance", "image-edit", "angle-control", "seamless-stitch", "midjourney-blend"]);
const paths: Record<string, string> = {
    "/video": "video", "/chat": "gpt-chat", "/prompts": "prompts", "/my-prompts": "my-prompts",
    "/assets": "assets", "/design-library": "design-library", "/reference-import": "reference-import",
    "/creative/pattern-placement": "pattern-placement", "/creative/pattern-repeat": "pattern-repeat", "/creative/series-recipe": "series-recipe",
};

export function designExampleForScene(id: string): DesignExample | undefined {
    return Object.hasOwn(designExamples, `creative-${id}`) ? designExamples[`creative-${id}`] : undefined;
}

/** The caller stays inside the existing AuthGate/ModuleGate. No route or feature is enabled here. */
export function designExampleForLocation(pathname: string, search = ""): DesignExample | undefined {
    if (pathname === "/image") {
        const tool = new URLSearchParams(search).get("tool") || "image";
        return imageTools.has(tool) ? designExamples[tool] : undefined;
    }
    const key = Object.hasOwn(paths, pathname) ? paths[pathname] : undefined;
    if (key) return designExamples[key];
    const scene = pathname.match(/^\/creative\/([^/]+)$/)?.[1];
    return scene ? designExampleForScene(scene) : undefined;
}
