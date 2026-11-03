/** Static teaching content only. Never imported into user history, tasks, assets or drafts. */
export type DesignExample = {
    id: string;
    title: string;
    category: string;
    brief: string;
    media: Array<{ src: string; label: string; alt: string }>;
    steps: Array<{ title: string; detail: string }>;
    prompt?: string;
    checks: string[];
    limitation: string;
    cost: string;
};

const asset = (name: string, label: string) => ({ src: `/design-examples/${name}.webp`, label, alt: label });
const pair = (name: string, before: string, after: string) => [asset(`${name}-source`, before), asset(name, after)];
const modelCost = "看案例、复制文字和下载教学素材不调用模型。实际点击生成后才提交任务，费用与可用模型以当前页面为准。";
const localCost = "本例是本地整理或编辑操作，不调用生成模型；需要 AI 生成的下一步仍须单独确认并提交。";
const visualLimit = "图片是 AI 原创教学示意，非 Zara 官方款式、非本平台模型实测。实际效果需逐项核对，不能直接作为纸样、生产色标或工艺文件。";

type ExampleContent = Omit<DesignExample, "id" | "cost" | "limitation"> & Partial<Pick<DesignExample, "cost" | "limitation">>;
const example = (id: string, content: ExampleContent): DesignExample => ({ id, cost: modelCost, limitation: visualLimit, ...content });

export const designExamples: Record<string, DesignExample> = {
    image: example("image", {
        title: "女装开发 · 把款式需求变成第一版提案", category: "女装",
        brief: "设计师收到通勤系列简报，先把廓形、面料和关键细节写清，再出一张可讨论的马甲效果图。",
        media: [asset("womenswear-source", "款式提案示意 · 灰褐色三扣马甲")],
        steps: [
            { title: "准备款式简报", detail: "确定成女通勤、V 领、无袖、三颗同色纽扣、双嵌线袋及灰褐色西装料。没有原款时用文字生图，不假装参考图已经上传。" },
            { title: "配置第一版", detail: "在图像生成填写设计要求，选择当前已启用的模型、画幅和数量。首轮建议先做 1 张，确认方向后再扩展。" },
            { title: "生成并检查", detail: "手动点击生成。检查扣子数量、领口、左右口袋和完整下摆；有问题时明确指出部位再改，不只说“高级一点”。" },
            { title: "形成提案", detail: "选定候选后下载图片；要连续改同一件产品，可把该结果作为下一轮参考或放入自己的新画布。" },
        ],
        prompt: "设计一件 Zara 风格的成女通勤马甲：灰褐色哑光西装料，清晰 V 领，无袖，轻收腰，中臀长度，前中三颗同色纽扣，左右各一个嵌线袋。正面完整白底商品图，不加品牌文字，不搭配其他服装。",
        checks: ["只有一件完整马甲，不混入模特或配饰", "三颗扣子、两只口袋，位置合理", "效果图用于沟通，不代替尺寸和纸样"],
    }),
    "image-edit": example("image-edit", {
        title: "包包改款 · 换包身材质，保留版型与肩带", category: "包包",
        brief: "买手认可包型，希望比较皮革与麂皮两个材质方向；只改包身，避免肩带和五金一起跑偏。",
        media: pair("bag", "参考原款 · 皮革包身", "教学效果 · 麂皮包身、原肩带保留"),
        steps: [
            { title: "准备单品原图", detail: "上传清楚展示包身、肩带、五金的单张原图；不要把左右对照图作为输入。" },
            { title: "说明改与不改", detail: "写明仅包身面片换深巧克力色细绒麂皮；肩带仍为原皮革，固定包型、接缝、环扣和背景。" },
            { title: "选择处理范围", detail: "页面提供选区且模型支持时只涂包身，避开肩带和五金；不使用选区时，文字约束仍需结果核验。" },
            { title: "查看结果", detail: "手动生成后对比包身绒感、肩带材质和环扣连接。满意再下载；原图及旧历史保持不变。" },
        ],
        prompt: "仅将包身大面片改为深巧克力色细绒麂皮，保留原包型、尺寸比例和接缝位置。肩带继续使用原皮革，金属环扣、背景、角度与光影不变。不加口袋、文字或装饰。",
        checks: ["包身与肩带材质有明确区分", "环扣仍连接在正确位置", "原款轮廓、包口和缝线没有被重画成另一款"],
    }),
    "detail-enhance": example("detail-enhance", {
        title: "毛衫提案 · 放大看清针路与罗纹", category: "毛衫",
        brief: "准备评款大图时，检查细针织、袖口和领口是否清楚；增强不是重新设计针法。",
        media: [asset("knit-source", "检查对象 · 领口、袖口、下摆与针织纹理")],
        steps: [
            { title: "选清晰原件", detail: "上传原始分辨率毛衫图，不用聊天截图或已压缩预览。增强前先记住领圈宽度和针路方向。" },
            { title: "配置增强", detail: "在细节增强选择当前可用处理模型及页面提供的倍率/参数；不要额外添加改款要求。" },
            { title: "局部核对", detail: "生成后放大查看领口、袖口、下摆和腋下，确认没有虚构麻花、改动针距或出现重复毛边。" },
            { title: "保存提案图", detail: "下载通过检查的结果，用于评款展示，同时保留原件作对照。" },
        ],
        checks: ["放大后没有新增纹样或多余边线", "罗纹和主体针路保持连续", "清晰度提升不等于真实纱线/针数测量"],
        limitation: "本页展示检查对象，不冒充增强前后实测。AI 可能补出不存在的纹理；技术沟通仍需原样和纱线/针法资料。",
    }),
    "angle-control": example("angle-control", {
        title: "包包评款 · 补一个侧向视角", category: "包包",
        brief: "正面已选定后，补充三分之二侧视提案，讨论包身厚度、肩带连接和侧缝。",
        media: [asset("bag-source", "输入 · 原款包包"), asset("bag-angle", "教学效果 · 侧向视角推演")],
        steps: [
            { title: "上传确定的原款", detail: "使用同一张清晰单品图，避免同时加入不同包型。" },
            { title: "设置视角", detail: "在角度控制调整页面提供的水平、垂直或远近参数，先试一个适度侧向角度。" },
            { title: "生成侧向提案", detail: "手动生成一张，检查包口、侧缝、肩带端点和金属环扣是否对应原款。" },
            { title: "区分推演与事实", detail: "把没有拍到的背侧结构标成设计建议；真正侧面结构需实物照片或版师资料确认。" },
        ],
        checks: ["没有多出第二根肩带或重复环扣", "前后轮廓与原包型能对应", "不可见结构不标成原款事实"],
    }),
    "seamless-stitch": example("seamless-stitch", {
        title: "围巾花型 · 把格纹单元接成连续图", category: "围巾",
        brief: "为围巾做连续格纹提案，重点检查相邻单元的线条是否接上，而不只看单张图好不好看。",
        media: [asset("pattern-source", "输入参考 · 驼棕格纹单元")],
        steps: [
            { title: "准备平面花型", detail: "用已整理的格纹单元，先去除服装轮廓、褶皱和背景；不要直接拿围巾商品照当平面花型。" },
            { title: "选择处理模型", detail: "在无缝拼接上传单元并选模型。只有当前模型显示内部工作流参数时才调整切割/重绘等值。" },
            { title: "检查平铺", detail: "生成后切换“2×2 平铺”，看横竖格线接缝、交点粗细、色块和明暗是否突变。" },
            { title: "确认后导出", detail: "有接缝就继续修正，不把单张看起来正常称为无缝；对齐后再下载单元。" },
        ],
        checks: ["2×2 的四个交界处格线连续", "边缘不变粗、不重复出双线", "生产循环尺寸与分色仍需另行确认"],
        limitation: "教学图是花型输入参考，不承诺已通过无缝拼接或达到织造循环要求。结果必须在平铺模式实看接缝。",
    }),
    "midjourney-blend": example("midjourney-blend", {
        title: "系列探索 · 用款型和针织质感找新方向", category: "女装 × 毛衫",
        brief: "早期方向会上，把马甲的利落结构与毛衫的柔软肌理作为两张视觉参考，探索混合概念。",
        media: [asset("womenswear-source", "参考一 · 马甲结构"), asset("knit-source", "参考二 · 针织肌理")],
        steps: [
            { title: "准备 2–4 张参考", detail: "本例选一张马甲和一张毛衫，去掉无关背景；不要堆很多重复图片。" },
            { title: "放入融合输入", detail: "进入 MJ 多图融合，上传参考并确认当前模型可用；此模式不需要填写提示词。" },
            { title: "生成方向候选", detail: "手动执行融合，看结构与材质如何组合。它适合找方向，不适合要求某个部位绝对不变。" },
            { title: "回到可控改款", detail: "选定方向后，用图片编辑或对话改图明确保留项，逐项完善。" },
        ],
        checks: ["输入张数满足页面要求", "不把随机融合当作精确保真改款", "选中方向后再细化，不直接送生产"],
        limitation: "此处展示两张设计参考，不伪造 MJ 的实际输出。融合结果有探索性，需在真实生成后人工选择。",
    }),
    video: example("video", {
        title: "包包提案 · 做一段材质展示短片", category: "包包",
        brief: "向买手展示选定包款的质感和轮廓，让镜头轻缓移动，不让产品在视频里变款。",
        media: [asset("bag", "起始参考帧示意 · 麂皮包包")],
        steps: [
            { title: "准备最终单品图", detail: "使用已选定的清晰原图，确保肩带和包身没有裁掉。" },
            { title: "选视频模型", detail: "选择当前支持图片参考的视频模型，上传起始图；时长和画幅以模型实际选项为准。" },
            { title: "只描述镜头", detail: "写慢速轻微推进、柔和棚光，要求保持包型/颜色/五金；避免一轮同时加换款、人物和复杂动作。" },
            { title: "逐段验片", detail: "手动生成后检查开头、中间、结尾，重点看肩带是否断裂、环扣是否变形、材质是否闪变。" },
        ],
        prompt: "以参考图包包为唯一主体，保持包型、深巧克力麂皮包身、原皮革肩带和金属环扣不变。白色影棚背景，柔和稳定光线，镜头缓慢轻微推进，展示材质细节。不要变款、不要新增手或人物、不要文字。",
        checks: ["整段包型与五金保持一致", "没有材质闪变或突然多出部件", "视频完整可播放后再下载交付"],
        limitation: "这里展示起始帧和操作步骤，不把静态图片当作视频成片。实际视频需要生成后逐段检查。",
    }),
    "gpt-chat": example("gpt-chat", {
        title: "对话改款 · 先锁定帽子，再只改翻边", category: "帽子",
        brief: "设计师保留已选帽型，用一句具体要求改局部；下一轮继续同一作品，不混到别的图。",
        media: pair("hat", "当前图 · 燕麦色针织帽", "教学效果 · 仅翻边变酒红"),
        steps: [
            { title: "确认当前图", detail: "上传原款，确认“当前图”指向这顶帽子。需要修改较早版本时先点对应图，不靠“上面那个”猜目标。" },
            { title: "说清改动边界", detail: "输入只改翻边为酒红、帽顶和纹理不变。可先纯讨论配色；明确要求出图时才执行改图。" },
            { title: "连续修改", detail: "结果返回后核对当前版本，再继续提出一个改动；想换作品时使用新创作，别把新参考误当旧图。" },
            { title: "处理等待状态", detail: "任务处理中可继续讨论；回执不明先查原任务，不反复发送同一句生成要求。" },
        ],
        prompt: "只把当前这顶帽子的翻边改为低饱和酒红色，帽顶仍为原燕麦色；帽高、翻边宽度、罗纹走向、纱线质感、角度和背景全部保持不变，不加装饰。",
        checks: ["当前图确实是要修改的帽子", "帽顶没有一起变色", "回执未知时先查询，不重复付费提交"],
    }),
    creative: example("creative", {
        title: "从一个款式任务，选择合适的设计工具", category: "帽子 · 包包 · 围巾 · 毛衫 · 女装 · 男装",
        brief: "把“给秋冬系列做一轮改款”拆成款式、配色、花型和工艺任务，每次只解决一个明确问题。",
        media: [asset("hat", "帽子 · 翻边配色"), asset("knit", "毛衫 · 同款配色"), asset("womenswear", "女装 · 纽扣细节")],
        steps: [
            { title: "先辨认任务", detail: "没有参考要出新款，选以文生款；只改部位选局部改款；只换颜色选服装配色；整理花纹用花型提取。" },
            { title: "准备对应输入", detail: "服装任务用完整单品原图；图案任务用平面图；辅料任务需要辅料结构图和独立图案两种参考。" },
            { title: "看本场景案例", detail: "进入场景先看“功能示例”，再在自己的任务中填表。示例不会写进你的结果或历史。" },
            { title: "核对再推进", detail: "先验结构与保留项，再验美感；需要定位/循环或系列分支时进入相应工作台。" },
        ],
        checks: ["工具与实际任务匹配", "参考角色不混淆", "没有把教学图片误认成自己已完成的作品"],
    }),
    "creative-text-to-style": example("creative-text-to-style", {
        title: "女装款式提案 · 灰褐色通勤马甲", category: "女装",
        brief: "把买手的通勤系列方向转成可讨论的单款，先解决廓形和关键细节。",
        media: [asset("womenswear-source", "文字开发的效果示意 · 三扣 V 领马甲")],
        steps: [
            { title: "准备", detail: "明确成女、通勤用途、V 领、三扣、嵌线袋和灰褐色面料；不需要伪造原款照片。" },
            { title: "填写表单", detail: "在款式描述写清要求，品类、廓形、面料和展示方式与描述保持一致。" },
            { title: "生成候选", detail: "确认可用模型和数量后手动生成，先检查领口、扣数、口袋与衣长。" },
            { title: "交付讨论", detail: "保留选定候选，与版师另行确认尺码、里布和工艺；不要直接把效果图当生产资料。" },
        ],
        prompt: "成女通勤系列马甲，灰褐色哑光西装料，V 领，无袖，轻收腰，中臀长度，前中三颗同色纽扣，左右嵌线袋，正面完整白底商品图。简洁都市感，无品牌文字。",
        checks: ["版型与穿着定位一致", "明确的细节数量没有遗漏", "不是纸样或成衣尺寸证明"],
    }),
    "creative-style-to-sketch": example("creative-style-to-sketch", {
        title: "毛衫评款 · 把照片整理成可见结构线稿", category: "毛衫",
        brief: "款式讨论前先弱化颜色和光影，让领圈、落肩、袖口与下摆结构更容易核对。",
        media: [asset("knit-source", "原款参考 · 圆领毛衫"), asset("knit-sketch", "教学效果 · 可见结构线稿")],
        steps: [
            { title: "上传原款", detail: "使用正面完整毛衫照片，领口和两只袖口都清楚可见。" },
            { title: "选择线稿风格", detail: "在款生线稿选择技术感线稿和适合的细节级别，不要求猜测看不到的后背结构。" },
            { title: "核对轮廓", detail: "生成后与照片对比领宽、落肩位置、袖长和罗纹区域；删除多余装饰线的要求要具体。" },
            { title: "需要路径再描摹", detail: "SVG 描摹工具可用时再做本地轮廓路径处理；得到路径不等于得到了可裁剪纸样。" },
        ],
        prompt: "整理为白底黑线的正面毛衫款式线稿，保留圆领、落肩、袖长、衣长与领口袖口下摆的罗纹范围。不增加图案，不推测背面，不标注虚构尺寸。",
        checks: ["外轮廓和比例对应原图", "罗纹区分清楚而不是画成麻花", "不含虚构尺寸或结构"],
    }),
    "creative-local-restyle": example("creative-local-restyle", {
        title: "女装细节 · 三颗纽扣换材质，其余不动", category: "女装",
        brief: "已选定马甲版型后，比较同色扣与哑光金属扣的系列气质。",
        media: pair("womenswear", "原款 · 三颗同色扣", "教学效果 · 三颗哑光金属扣"),
        steps: [
            { title: "准备原款", detail: "上传完整马甲图，确认三颗纽扣都可辨认。" },
            { title: "指定部位", detail: "在局部改款把部位设为纽扣，并写清原位置、原直径和数量全部保留，只改为哑光仿古金属。" },
            { title: "使用选区", detail: "选区工具已启用且模型支持时分别涂选纽扣，避开门襟；未选区时仍需逐项核对。" },
            { title: "检查与保存", detail: "生成后确认没有改领口、口袋或衣身颜色。效果合适再交由工艺人员确认扣脚、厚度和重量。" },
        ],
        prompt: "仅将原款前中三颗棕色纽扣替换为同直径、同位置的哑光仿古金色圆形金属扣。保留灰褐色面料、V 领、门襟、口袋、衣长和全部缝线，不增加第四颗扣。",
        checks: ["仍然恰好三颗扣", "门襟、口袋和面料颜色不变", "金属扣连接方式需实物确认"],
    }),
    "creative-garment-colorway": example("creative-garment-colorway", {
        title: "毛衫配色 · 燕麦色扩成海军蓝方案", category: "毛衫",
        brief: "同一款型扩展色组，避免为了换色把领口、针路和衣长也改掉。",
        media: pair("knit", "原款 · 燕麦色", "教学效果 · 海军蓝"),
        steps: [
            { title: "上传一张原款", detail: "选无明显色偏的正面单品照片，记录领口和罗纹比例。" },
            { title: "选配色方式", detail: "本例使用指定颜色或配色参考。选标准色/照片取色时注意它只规定视觉方向，不是实物色差保证。" },
            { title: "限定区域", detail: "把改色范围写为整个毛衫，要求版型、针织肌理、背景保持；不要求同时换纱或加图案。" },
            { title: "比较候选", detail: "生成后并排检查色组及高光阴影；保留原图，另存配色结果，不覆盖历史。" },
        ],
        prompt: "仅将整件毛衫调整为低饱和深海军蓝，保留原圆领、落肩、袖长、衣长、罗纹宽度、针织肌理和背景。不添加图案，不改变纱线粗细。",
        checks: ["领袖下摆仍是同一款", "暗色区域仍保留针织层次", "颜色最终用实体色卡与纱样确认"],
    }),
    "creative-back-design": example("creative-back-design", {
        title: "男装补视图 · 为针织 Polo 推演简洁背面", category: "男装",
        brief: "只有正面参考时，为设计讨论补一张风格一致的背面候选，清楚标明这是设计推演。",
        media: [asset("menswear-source", "输入 · 男装 Polo 正面"), asset("menswear-back", "教学效果 · 背面设计推演")],
        steps: [
            { title: "准备正面", detail: "上传清晰的海军蓝长袖针织 Polo，确保领形、袖口和下摆完整。" },
            { title: "选择背面方向", detail: "在背面设计选择简洁结构，不延续不存在的后背图案；补充同色同材质、不加后背装饰的要求。" },
            { title: "核对一致性", detail: "生成后对比袖长、肩线、衣长和下摆罗纹范围，排除背面多出前门襟或扣子的情况。" },
            { title: "确认未知结构", detail: "将背面交版师或实物资料确认；未确认前在提案中标记“背面设计建议”。" },
        ],
        prompt: "为这件海军蓝长袖针织 Polo 设计简洁背面，保留同一领型、针织质感、袖长、衣长及袖口下摆罗纹比例。背面无纽扣门襟、无图案、无品牌字样。正后方完整白底商品视图。",
        checks: ["背面没有前门襟和纽扣", "肩线与袖长对应正面", "没有把推演图宣称成原款背面"],
    }),
    "creative-pattern-extract": example("creative-pattern-extract", {
        title: "围巾花型 · 从商品照整理格纹方向", category: "围巾",
        brief: "为下一季色组开发，把看得见的格纹整理成平面参考，去掉褶皱与围巾轮廓。",
        media: [asset("scarf-source", "输入 · 格纹围巾"), asset("pattern-source", "教学效果 · 平面格纹参考")],
        steps: [
            { title: "检查原图", detail: "选择格纹清晰、遮挡较少的照片。先说明只整理可见格线，不声称还原未拍到的纹样。" },
            { title: "设置提取", detail: "在花型提取选择需要的平面模式和背景，并写清保留驼棕色组及疏朗格线比例。" },
            { title: "校正平面关系", detail: "生成后检查横竖线粗细和间距，区分拍照透视造成的变形与真实图案。" },
            { title: "继续开发", detail: "确认平面参考后再去图案配色或四方连续工作台；提取本身不保证已经无缝。" },
        ],
        prompt: "从这条围巾中整理清楚可见的驼色底、棕色细窗格纹，去除围巾轮廓、流苏、阴影和褶皱，平展为正视平面图案参考，保持疏朗格线比例，不新增装饰或文字。",
        checks: ["没有围巾边缘或阴影残留", "格线比例有依据，不凭空增加纹样", "平面参考不等于无缝生产稿"],
    }),
    "creative-pattern-colorway": example("creative-pattern-colorway", {
        title: "围巾图案配色 · 格纹不动，只换色组", category: "围巾",
        brief: "保留已选窗格纹的线条和循环关系，把暖驼棕方向调整成米白海军蓝。",
        media: [asset("pattern-source", "输入 · 驼棕格纹"), asset("pattern", "教学效果 · 米白海军蓝格纹")],
        steps: [
            { title: "准备平面稿", detail: "使用不带商品褶皱的格纹参考，不直接拿围巾实拍图做生产色版。" },
            { title: "指定色组", detail: "在图案配色选指定颜色或配色参考，明确底色米白、线条海军蓝，格线宽度和位置不动。" },
            { title: "选择合适方式", detail: "AI 方式用于视觉探索；已启用精确换色时，可对纯色像素作本地 RGB 替换，仍须看抗锯齿边缘。" },
            { title: "比较与导出", detail: "检查每种颜色是否对应正确区域，再导出版本；印染颜色需另外对实体标准确认。" },
        ],
        prompt: "保留格纹线条的形状、粗细、间距和排列，仅把驼色底改为柔和米白、棕色格线改为深海军蓝。不新增格线，不移动图案，不增加纹理或阴影。",
        checks: ["只改色，不改图案密度", "边缘没有旧色残留", "数字色值不等于印染实物颜色"],
    }),
    "creative-pattern-craft": example("creative-pattern-craft", {
        title: "围巾工艺提案 · 平面格纹到提花观感", category: "围巾",
        brief: "评估格纹从平面图到织物上的视觉质感，用于沟通工艺方向，不生成组织图。",
        media: [asset("pattern-source", "输入 · 平面格纹"), asset("pattern-craft", "教学效果 · 毛感织物上的提花观感")],
        steps: [
            { title: "准备平面纹样", detail: "使用明确的格线与色组，先确认图案几何关系。" },
            { title: "选工艺和底材", detail: "在图案工艺选择提花及相应面料描述，强调格线比例、颜色数量和边界不变。" },
            { title: "看工艺表达", detail: "生成后看纹样是否像织入面料，而不是浮在表面；检查格线有没有变成凸起绳条。" },
            { title: "交接打样", detail: "把通过的观感图配原平面稿交给工艺人员；针数、组织、纱支和织造方式另行确定。" },
        ],
        prompt: "将这份驼棕格纹表现为柔软毛感围巾面料的提花观感，保持格线比例、位置与两色关系，细腻织物肌理，不加刺绣边框，不把格线做成突起绳条。正视平铺材质样片。",
        checks: ["图案几何和色组仍对应输入", "织物质感符合围巾用途", "不把效果图当提花组织文件"],
    }),
    "creative-accessory-design": example("creative-accessory-design", {
        title: "包包辅料 · 用几何纹样开发拉链头", category: "包包",
        brief: "包型不变，通过一枚低调的金属拉链头呼应系列的几何线条。",
        media: [asset("hardware-source", "图片一 · 拉链头结构参考"), { src: "/design-examples/diamond-mark.svg", label: "图片二 · 原创几何纹样", alt: "简洁菱形线条纹样，非品牌标志" }, asset("hardware", "教学效果 · 几何压纹拉链头")],
        steps: [
            { title: "分开两种参考", detail: "图片一上传拉链头，确定外轮廓、孔位和金属材质；图片二上传独立几何纹样，只提供装饰。" },
            { title: "填写辅料要求", detail: "在辅料设计选择拉链头及纹样应用，写明不改变连接孔、厚度观感和圆角轮廓。" },
            { title: "生成并核对", detail: "手动生成后检查纹样是否落在实体面上，孔位是否被堵住、边缘是否过薄。" },
            { title: "确认工程参数", detail: "选定视觉方向后，与供应商核对尺寸、合金、电镀、模具、孔位和拉力，不用图片代替打样。" },
        ],
        prompt: "图片一负责金属拉链头结构、连接孔位和圆角轮廓；图片二只提供菱形线条。把纹样做成正面浅压纹，保留连接孔畅通，哑光仿古金属质感，不加品牌文字，不改变拉链头外形。",
        checks: ["参考图分工正确", "连接孔没有被纹样填满", "装饰尺度与实体边缘厚度合理"],
    }),
    "pattern-placement": example("pattern-placement", {
        title: "帽子定位 · 比较小图案在翻边上的位置", category: "帽子",
        brief: "在已定帽型上测试一枚小几何标的位置和大小，不改变整顶帽子的针织结构。",
        media: [asset("hat-source", "底图 · 针织帽"), { src: "/design-examples/diamond-mark.svg", label: "定位素材 · 原创几何线条", alt: "用于定位练习的简洁菱形线条" }],
        steps: [
            { title: "准备两层素材", detail: "上传帽子底图和独立透明纹样；先检查素材边缘与透明背景。" },
            { title: "调整定位", detail: "在图案定位工作台移动、缩放和旋转纹样，放在翻边前侧，留出接缝与边缘间距。" },
            { title: "比较大小", detail: "保留小尺寸与中尺寸两个方案，按同一观察比例比较；用底图实物尺寸标定后才讨论毫米。" },
            { title: "导出提案", detail: "导出画面及工程备份。贴图仅用于位置沟通，针织起伏上的真实刺绣需打样。" },
        ],
        cost: localCost, checks: ["图案没有跨越翻边边缘", "不同方案在同一缩放比例下比较", "未校准尺寸时不用屏幕像素冒充毫米"],
    }),
    "pattern-repeat": example("pattern-repeat", {
        title: "围巾循环 · 手动编排几何纹样的疏密", category: "围巾",
        brief: "同一个小几何纹样做不同疏密的满版方案，观察连续排列是否适合围巾幅面。",
        media: [{ src: "/design-examples/diamond-mark.svg", label: "输入 · 原创几何纹样", alt: "用于重复排列练习的菱形线条" }, asset("scarf-source", "用途参考 · 围巾比例，不是自动贴图结果")],
        steps: [
            { title: "导入独立纹样", detail: "在四方连续工作台添加透明底几何图案；不要带入商品照的阴影和轮廓。" },
            { title: "设置循环关系", detail: "使用页面提供的重复/错位方式，调整单元尺寸、图案比例和间距。先保留一版较疏的基准。" },
            { title: "看交界和疏密", detail: "在重复预览里检查四边、交点和视觉节奏；不能只看一个单元。" },
            { title: "导出单元与工程", detail: "保存当前工程和图案单元；生产幅宽、循环尺寸和颜色数量需另行核对。" },
        ],
        cost: localCost, checks: ["跨边图案接得上", "密度适合围巾而不是贴满所有品类", "导出单元与工程版本对应"],
    }),
    "series-recipe": example("series-recipe", {
        title: "毛衫色组 · 三条分支做配色提案", category: "毛衫",
        brief: "同一毛衫按三种配色方向出候选，保留统一款型，并能区分各分支的状态和费用。",
        media: pair("knit", "基准款 · 燕麦色毛衫", "候选方向示意 · 海军蓝"),
        steps: [
            { title: "选同一个基准", detail: "上传毛衫原图，约定领口、针路、袖长和衣长不变，准备三个明确的色组方向。" },
            { title: "配置各分支", detail: "在系列配方分别填写每个分支的颜色与要求，检查页面显示的模型和费用估计。每个分支是独立生成。" },
            { title: "手动运行配方", detail: "点击运行后观察各分支状态；未知回执先用“查询原任务”，不要直接重跑整组。" },
            { title: "选款与保存", detail: "比较色组，选择要保留的候选，导出提案板并保存/导出完整工程。" },
        ],
        prompt: "以同一件毛衫为基准，各分支只改变明确指定的颜色。共同保留圆领、落肩、袖长、衣长、罗纹范围和针织肌理，不添加图案。",
        checks: ["各分支的目标颜色不同且明确", "不把三分支误认为一次免费调用", "保存的项目保留每个分支的真实状态"],
    }),
    prompts: example("prompts", {
        title: "提示词复用 · 把帽子局部改色要求写完整", category: "帽子",
        brief: "借用现成的描述结构，把具体产品、变化部位和保留项换成当前设计任务。",
        media: pair("hat", "任务对象 · 原针织帽", "目标方向示意 · 翻边酒红"),
        steps: [
            { title: "查找相关描述", detail: "在提示词库搜索改款、针织或局部配色，先阅读全文再决定是否适用。" },
            { title: "按任务改写", detail: "明确当前图是谁、只改哪里、哪些不变，不照搬无关人物、场景或材质。" },
            { title: "手动使用", detail: "复制文字到自己的设计任务并上传对应原图；复制本身不会生成或创建历史。" },
            { title: "核对效果", detail: "生成后按保留项检查，必要时改写描述；提示词不是每个模型都能完全遵守的保证。" },
        ],
        prompt: "仅将当前针织帽的翻边改为低饱和酒红色，帽顶仍为燕麦色；帽高、翻边宽度、针织纹理、角度和背景保持不变，不加装饰。",
        cost: localCost, checks: ["明确改动对象和部位", "保留项与当前图片一致", "没有复制不需要的风格或内容"],
    }),
    "my-prompts": example("my-prompts", {
        title: "个人方法库 · 留下可复用的毛衫改色模板", category: "毛衫",
        brief: "把验证过的表达方式保存为个人提示词，下次换款时只替换产品和颜色，不保存客户隐私。",
        media: pair("knit", "原款参考 · 毛衫", "色组方向示意 · 海军蓝"),
        steps: [
            { title: "提炼模板", detail: "保留“对象＋只改什么＋必须保留什么”的结构，把色名和款式部位改为明确占位项。" },
            { title: "手动新建", detail: "在我的提示词点击新建，填写名称、分类和内容；教学案例不会自动加入你的列表。" },
            { title: "替换占位项", detail: "使用前填入本次目标色与原款特征，不把上一款的领型或材质带入新款。" },
            { title: "持续校对", detail: "有真实有效的改进再更新模板；不要保存客户账号、内部接口或密钥。" },
        ],
        prompt: "对【当前原款】仅将【目标区域】改为【目标颜色】；保留【版型、领口、袖口、下摆、图案位置、面料纹理】及原背景。不要增加未要求的装饰。使用前请替换所有占位项。",
        cost: localCost, checks: ["所有占位项已替换", "没有误带上一款约束", "个人提示词条目必须由本人主动保存"],
    }),
    assets: example("assets", {
        title: "素材整理 · 把包款原图与材质方案分开存", category: "包包",
        brief: "设计师要反复使用同一包型，区分原款、材质方案和最终选款，避免把小预览当原件。",
        media: pair("bag", "原款素材 · 皮革包", "方案素材 · 麂皮包身"),
        steps: [
            { title: "准备原始文件", detail: "整理有权使用的单品原件，名称标明品类、款号、正侧面与版本。不要拿客户隐私截图作素材。" },
            { title: "主动上传与分类", detail: "在素材库上传文件并按已有分类整理；本案例不会自动给你创建素材。" },
            { title: "确认选对版本", detail: "预览图片、核对名称和内容，区分原款与改款；需要原图时用下载原件。" },
            { title: "在任务中复用", detail: "从支持素材库的选择入口插入参考，仍须确认参考角色并手动生成。" },
        ],
        cost: localCost, checks: ["文件名能辨认版本", "原件与方案分开", "不要把缩略图或教学示意当已验收样品"],
    }),
    "design-library": example("design-library", {
        title: "设计灵感库 · 分享系列方向，不混成个人历史", category: "男装 × 帽子 × 围巾",
        brief: "将团队讨论通过的色组或细节方向放入灵感库，便于同事查看和引用，清楚区分灵感与最终样品。",
        media: [asset("menswear", "男装方向 · 细撞色边"), asset("hat", "帽子方向 · 局部配色"), asset("scarf", "围巾方向 · 米白深蓝格纹")],
        steps: [
            { title: "选择可分享内容", detail: "确认图片可在公司范围使用，并标明是灵感、提案还是已确认样品。" },
            { title: "按权限操作", detail: "使用页面实际提供的上传或分享入口；没有管理权限时只浏览/引用，不绕过权限。" },
            { title: "保留来源与说明", detail: "写清颜色、材质或廓形的参考角色，不让同事误把它当原样生产资料。" },
            { title: "复制后再开发", detail: "引用到自己的任务后继续修改；原灵感记录和同事作品不会因看案例而被更改。" },
        ],
        cost: localCost, checks: ["分享范围与授权明确", "灵感、提案、样品状态区分", "不冒充同事的真实作品或确认记录"],
    }),
    "reference-import": example("reference-import", {
        title: "参考采集 · 建立一组有来源的围巾色组参考", category: "围巾",
        brief: "做新一季方向前，先收集有权使用的公开产品参考，保留来源并在导入前审核。",
        media: [asset("scarf-source", "示例内容方向 · 驼棕格纹围巾"), asset("scarf", "对比方向 · 米白海军蓝")],
        steps: [
            { title: "准备公开链接", detail: "粘贴允许读取的产品页链接；教学图不是真实抓取结果，也不会自动访问外部网站。" },
            { title: "扫描并筛选", detail: "点击扫描后，从候选图中勾选真正需要的单品图，去掉 logo、图标和重复小图。" },
            { title: "读取后审核", detail: "读取所选图片，确认可解码、来源正确、内容有用；需要登录或防盗链的内容不保证能取得。" },
            { title: "主动导入", detail: "最后手动确认导入素材库，保留来源信息；采集不是商业使用授权。" },
        ],
        cost: localCost, checks: ["来源链接与图片对应", "不导入无用图标或重复缩略图", "不绕过登录、付费或版权限制"],
    }),
};

const imageTools = new Set(["image", "detail-enhance", "image-edit", "angle-control", "seamless-stitch", "midjourney-blend"]);
const paths: Record<string, string> = {
    "/creative": "creative", "/video": "video", "/chat": "gpt-chat", "/prompts": "prompts", "/my-prompts": "my-prompts",
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
        return designExamples[imageTools.has(tool) ? tool : "image"];
    }
    const key = Object.hasOwn(paths, pathname) ? paths[pathname] : undefined;
    if (key) return designExamples[key];
    const scene = pathname.match(/^\/creative\/([^/]+)$/)?.[1];
    return scene ? designExampleForScene(scene) : undefined;
}
