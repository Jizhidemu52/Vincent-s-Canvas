export type GeneralPromptTemplate = {
  id: string;
  title: string;
  category: string;
  prompt: string;
  targetTool: "image-generation" | "image-edit" | "video";
  notes: string;
  tags: string[];
  sources: { title: string; url: string }[];
};

// Original reusable Chinese templates. Sources inform the writing method, not
// copied prompt text or a claim that every template has been generation-tested.
const edit = { title: "BFL：明确修改对象、变化与保留项", url: "https://docs.bfl.ai/guides/prompting_editing_single_reference" };
const references = { title: "BFL：多图分工与位置关系", url: "https://docs.bfl.ai/guides/prompting_editing_multi_reference" };
const fashion = { title: "BFL：服装与配饰编辑场景", url: "https://docs.bfl.ai/guides/usecases_editing_clothing_tryon" };
const compose = { title: "Adobe：主体、画面特征与光线描述", url: "https://helpx.adobe.com/firefly/web/work-with-images/generate-images/writing-effective-text-prompts.html" };
const motion = { title: "Adobe：视频动作、镜头与节奏描述", url: "https://helpx.adobe.com/firefly/web/work-with-audio-and-video/work-with-video/writing-effective-text-prompts-for-video-generation.html" };

export const generalPromptTemplates: GeneralPromptTemplate[] = [
  {
    id: "clean-product-background", title: "商品提取 · 干净白底", category: "商品处理", targetTool: "image-edit", tags: ["白底", "产品提取", "电商"], sources: [edit],
    notes: "上传一张商品图；有多个商品时，先把[目标商品]换成具体位置和名称。",
    prompt: "【TARGET】从图一中提取[目标商品]，制作一张完整的白底商品图。\n\n【CHANGE】移除商品之外的人物、手、道具和原背景，改为均匀纯白背景。商品边缘干净自然；只有被小范围遮挡的边缘按相邻结构连续补齐。\n\n【LOCK】保留商品的整体轮廓、长宽比例、原有颜色、材质纹理、图案位置、五金数量和已有文字。\n\n【OUTPUT】单件商品完整入镜，居中摆放，四周留出适度空白，保留轻微自然落影。\n\n【EXCLUDE】不重新设计商品，不添加装饰、额外标识或说明文字。",
  },
  {
    id: "precise-local-recolor", title: "局部改色 · 只改指定部位", category: "商品处理", targetTool: "image-edit", tags: ["改色", "局部", "保留结构"], sources: [edit, fashion],
    notes: "上传原图；替换[目标部位]、[目标颜色]。",
    prompt: "【TARGET】只修改图一中[目标部位]的颜色，将它改为[目标颜色]。\n\n【CHANGE】新颜色完整覆盖该部位的原色，沿真实接缝和物体边界结束；根据原有光照保留高光、阴影和褶皱的明暗变化。\n\n【LOCK】其余部位的颜色保持原样；整体形状、尺寸比例、织纹、图案、Logo、五金、摆放位置及背景不变。同色但不属于目标部位的对象不修改。\n\n【OUTPUT】输出与图一相同视角和构图的改色效果图。\n\n【EXCLUDE】不新增拼色，不把目标颜色扩散到邻近部件或背景。",
  },
  {
    id: "remove-one-decoration", title: "删除装饰 · 补回原有面料", category: "商品处理", targetTool: "image-edit", tags: ["删除", "局部修改", "面料修补"], sources: [edit],
    notes: "上传原图；把[装饰的位置与名称]写清楚。",
    prompt: "【TARGET】删除图一中[装饰的位置与名称]，仅处理这一处。\n\n【CHANGE】移除该装饰及其独立投影。空出区域用周围原有面料自然接续，织纹方向、纹理尺度、底色、褶皱走向与相邻区域连续。\n\n【LOCK】保持商品轮廓、接缝、其余装饰、图案、配色、五金和原有构图不变。\n\n【OUTPUT】输出完整商品的修改效果图，修补区域与原面料融合。\n\n【EXCLUDE】不增加替代装饰，不抹平整件商品的织物细节。",
  },
  {
    id: "extend-scene-background", title: "扩展画面 · 商品比例不变", category: "商品处理", targetTool: "image-edit", tags: ["扩图", "背景", "横幅"], sources: [edit],
    notes: "上传原图；替换[扩展方向]，并在页面选择需要的画幅。",
    prompt: "【TARGET】沿图一的[扩展方向]扩展背景，为原商品增加留白。\n\n【CHANGE】新增区域延续原背景的空间、地面、色调、纹理和光线方向，使原画面与扩展区域自然衔接。\n\n【LOCK】商品本身不拉伸、不缩放、不改变设计；其轮廓、文字、纹理、颜色及与原地面的接触关系保持一致。\n\n【OUTPUT】在所选画幅内保留完整商品，新增空间干净、适合后续排版。\n\n【EXCLUDE】不复制第二件商品，不凭空加入道具或标题。",
  },
  {
    id: "material-transfer", title: "更换面料 · 款式保留", category: "服装与配饰", targetTool: "image-edit", tags: ["换面料", "双图参考", "材质"], sources: [references, fashion],
    notes: "图一上传款式，图二上传面料细节；替换[更换部位]。",
    prompt: "【TARGET】以图一为款式主图，只将[更换部位]改成图二的面料效果。\n\n【CHANGE】图二只提供面料的颜色、可见织纹、纹理尺度与表面光泽，不提供商品造型或背景。让新面料随图一该部位的曲面、褶皱和接缝自然变化。\n\n【LOCK】保留图一的款式结构、领口、袖型、开口、口袋、纽扣数量及整体比例；未指定换料的部分保持原样。\n\n【FABRIC DETAIL】呈现图二可见的组织和厚薄观感，并允许对应的局部反光和垂坠发生合理变化。\n\n【OUTPUT】保持图一视角，输出单款面料替换效果图。\n\n【EXCLUDE】不把图二的拍摄阴影或背景图案当成面料纹样。",
  },
  {
    id: "garment-to-flat-sketch", title: "款式转线稿 · 正面结构", category: "服装与配饰", targetTool: "image-edit", tags: ["线稿", "款式图", "结构"], sources: [edit],
    notes: "上传清楚的正面款式图。",
    prompt: "【TARGET】将图一中服装转换为白底黑线的正面平面款式示意图。\n\n【CHANGE】去除人物、背景、摄影阴影和色彩，用清晰连贯的线条表现外轮廓、领口、袖型、衣襟、口袋、纽扣、拼接线和可见装饰。主轮廓略粗，内部结构线略细。\n\n【LOCK】保留图一可见的款式比例、部件数量、左右关系和装饰位置。\n\n【OUTPUT】单件服装完整居中，线条清爽，轮廓与结构便于查看。\n\n【EXCLUDE】不补造看不见的背面、内部工艺或尺寸标注，不添加人体和背景装饰。",
  },
  {
    id: "sketch-product-render", title: "线稿转效果图 · 指定面料", category: "服装与配饰", targetTool: "image-edit", tags: ["线稿渲染", "面料", "效果图"], sources: [edit, compose],
    notes: "上传款式线稿；替换[面料与颜色]。",
    prompt: "【TARGET】把图一的款式线稿渲染为[面料与颜色]的真实商品效果图。\n\n【CHANGE】在线稿确定的结构内表现面料纹理、接缝、厚薄、自然褶皱和柔和立体光影。纽扣、拉链等部件按线稿位置呈现。\n\n【LOCK】保留外轮廓、衣长与袖长比例、领型、口袋、开口和装饰数量；线稿没有的部件不新增。\n\n【OUTPUT】单件完整商品，正面展示，干净浅色背景，重点呈现款式与面料。\n\n【EXCLUDE】不自动加入人物、文字、水印或额外搭配。",
  },
  {
    id: "controlled-style-change", title: "参考改款 · 只改指定设计点", category: "服装与配饰", targetTool: "image-edit", tags: ["改款", "设计开发", "局部"], sources: [edit, fashion],
    notes: "上传原款；替换[具体改动]，例如把圆领改为小V领。",
    prompt: "【TARGET】以图一为基础进行一次局部改款：[具体改动]。\n\n【CHANGE】把新设计准确落实到相应部位，连接处的缝线、面料转折和局部光影随新结构自然调整。\n\n【LOCK】未涉及的衣长、袖型、宽松程度、面料、配色、口袋、纽扣和装饰保持原设计；不要用保留原结构抵消本次明确改动。\n\n【OUTPUT】保持图一的展示方式和构图，输出一张完整改款效果图。\n\n【EXCLUDE】不顺带更换主题、添加图案、改背景或新增不相关配饰。",
  },
  {
    id: "new-style-from-brief", title: "文字开发 · 单款服装提案", category: "服装与配饰", targetTool: "image-generation", tags: ["文字生图", "服装开发", "新品"], sources: [compose],
    notes: "不需要参考图；替换品类、客群、版型、面料、颜色和设计细节。",
    prompt: "【TARGET】设计一款面向[客群与场合]的[服装品类]，以完整商品效果图展示。\n\n【CHANGE】采用[版型与长度]，领口为[领型]，袖子为[袖型]；明确呈现[口袋、开合方式与装饰细节]。各部件的位置和数量清楚，整体设计统一。\n\n【FABRIC DETAIL】使用[面料外观]，主色为[颜色]，通过柔和光线表现织纹、垂坠与接缝。\n\n【OUTPUT】正面完整单款，背景简洁，主体占画面主要位置，留出适度边距。\n\n【EXCLUDE】不添加品牌标识、价格、说明文字或参考图中并不存在的要求。",
  },
  {
    id: "pattern-extraction", title: "图案提取 · 转为平面图", category: "图案与工艺", targetTool: "image-edit", tags: ["提取图案", "印花", "平面稿"], sources: [edit],
    notes: "上传带图案的商品图；替换[图案所在部位]。",
    prompt: "【TARGET】从图一的[图案所在部位]提取完整可见图案，转换为正视平面图。\n\n【CHANGE】去除商品形体、布料褶皱、摄影投影和透视变形，使图案平展；沿原图可见证据接续被轻微褶皱打断的线条。\n\n【LOCK】保持元素数量、形状特征、相对位置、原有色块、线条粗细和图案整体长宽比例。\n\n【OUTPUT】图案完整居中，使用纯净背景，边界清楚，便于进一步排版。\n\n【EXCLUDE】不重新设计元素，不增加新的装饰，不把商品纹理混入图案；大面积不可见部分不凭空添加新主题。",
  },
  {
    id: "pattern-recolor", title: "花型换色 · 排列不变", category: "图案与工艺", targetTool: "image-edit", tags: ["花型", "配色", "色块"], sources: [edit],
    notes: "上传平面花型；逐项替换[元素与目标色对应表]。",
    prompt: "【TARGET】只修改图一花型的颜色，按[元素与目标色对应表]逐项替换。\n\n【CHANGE】把目标颜色绑定到对应的底色、轮廓线和具体元素，色块边界保持利落；不同元素即使原色相同，也只按指定对应关系处理。\n\n【LOCK】元素数量、大小、轮廓、线条、密度、方向、间距、排列和整体比例全部保持原样。\n\n【OUTPUT】与图一相同构图的完整平面花型，无摄影效果和立体投影。\n\n【EXCLUDE】不新增颜色，不改元素造型，不自动重新排花。",
  },
  {
    id: "pattern-motif-variant", title: "花型变体 · 保留整体风格", category: "图案与工艺", targetTool: "image-edit", tags: ["花型变体", "元素开发", "设计"], sources: [edit, compose],
    notes: "上传平面花型；替换[要调整的元素与具体变化]。",
    prompt: "【TARGET】以图一的平面花型为基础，调整[要调整的元素与具体变化]。\n\n【CHANGE】新元素在轮廓、细节或朝向上体现指定变化，与原图的线条语言、色块方式和装饰节奏统一。允许因新轮廓调整相邻空隙，使分布自然。\n\n【LOCK】保留原有配色体系、整体风格、主体与陪衬的层级、平均密度和画面比例；未指定变化的元素继续使用原设计。\n\n【OUTPUT】一张完整平面花型方案，元素边缘清楚。\n\n【EXCLUDE】不加入无关主题、文字、织物摄影纹理或立体光影。",
  },
  {
    id: "print-to-garment", title: "图案上身 · 指定位置与大小", category: "图案与工艺", targetTool: "image-edit", tags: ["图案定位", "印花效果", "双图"], sources: [references],
    notes: "图一上传服装，图二上传图案；替换[位置]和[相对大小]。",
    prompt: "【TARGET】以图一服装为主图，把图二图案放在服装的[位置]，大小为[相对大小]。\n\n【CHANGE】图二只提供图案本身。图案中心、方向和边缘按指定位置落在面料上，随真实曲面和褶皱发生合理透视，呈现附着在面料上的印花效果。\n\n【LOCK】保留图二图案的元素关系、颜色和长宽比；保留图一服装款式、面料、底色、其余装饰、姿态与背景。\n\n【OUTPUT】一张完整服装的印花定位效果图。\n\n【EXCLUDE】不把图案漂浮在衣服前方，不改成刺绣或贴布，不扩散到未指定区域。",
  },
  {
    id: "embroidery-effect", title: "平面图案 · 刺绣效果", category: "图案与工艺", targetTool: "image-edit", tags: ["刺绣", "工艺效果", "针迹"], sources: [edit, compose],
    notes: "上传平面图案；替换[底布外观]和[绣线配色]。",
    prompt: "【TARGET】将图一图案表现为绣在[底布外观]上的刺绣效果。\n\n【CHANGE】按[绣线配色]呈现绣线，较细轮廓使用连续紧凑的线迹，较宽色块使用顺着形状走向的填针。边缘有真实线头转折与轻微厚度。\n\n【LOCK】保留图案整体比例、元素数量、轮廓关系和各色区域，不重新排布。\n\n【FABRIC DETAIL】底布纹理清楚但不抢主体；绣线高光跟随针迹方向，投影只体现轻微隆起。\n\n【OUTPUT】正视工艺效果特写，图案完整，便于观察针迹与底布关系。\n\n【EXCLUDE】不做成印刷贴纸、塑料浮雕或金属雕刻，不增加新图案。",
  },
  {
    id: "jacquard-effect", title: "平面图案 · 针织提花效果", category: "图案与工艺", targetTool: "image-edit", tags: ["提花", "针织", "纹理"], sources: [edit, compose],
    notes: "上传平面图案；替换[底色与花色]。",
    prompt: "【TARGET】把图一图案转换为针织提花的视觉效果，配色采用[底色与花色]。\n\n【CHANGE】图案由织物线圈结构形成，边缘随线圈呈细微阶梯变化，花色与底色属于同一织片，而不是贴在表面的装饰。\n\n【LOCK】保留主元素形状特征、数量、布局、整体比例和色块对应关系。\n\n【FABRIC DETAIL】线圈尺度统一，组织连续；光线柔和，呈现纱线自然柔软和织物平整感。\n\n【OUTPUT】正面平展的针织面料效果图，完整展示图案。\n\n【EXCLUDE】不改成刺绣、印花、毛毡贴布，不编造针数、机号或生产参数。",
  },
  {
    id: "model-garment-tryon", title: "模特换装 · 人物与服装分开参考", category: "场景与展示", targetTool: "image-edit", tags: ["模特", "换装", "双图参考"], sources: [references, fashion],
    notes: "图一上传模特，图二上传目标服装。",
    prompt: "【TARGET】以图一为人物和场景主图，让图一模特穿上图二的服装。\n\n【CHANGE】图二只提供目标服装的款式、颜色、面料和装饰。服装自然贴合模特姿态，领口、袖口、腰身和下摆与身体关系合理，褶皱与遮挡随穿着自然形成。\n\n【LOCK】保留图一人物五官、发型、肤色、姿态、构图和背景；保留图二服装的领型、开合结构、口袋、图案和主要比例。\n\n【OUTPUT】输出与图一构图一致的模特上身效果图，服装展示清楚。\n\n【EXCLUDE】不把图二背景、衣架或其他配饰一同迁移，不改变模特身份特征。",
  },
  {
    id: "accessory-wearing", title: "饰品佩戴 · 尺寸与接触自然", category: "场景与展示", targetTool: "image-edit", tags: ["饰品", "佩戴", "首饰"], sources: [references, fashion],
    notes: "图一上传人物，图二上传饰品；替换[佩戴位置与相对大小]。",
    prompt: "【TARGET】在图一人物的[佩戴位置与相对大小]展示图二饰品。\n\n【CHANGE】图二只提供饰品造型、材料、颜色和部件关系。饰品与耳垂、颈部、头发或手腕按实际佩戴方式连接，垂挂方向符合重力，接触处有合理遮挡和柔和投影。\n\n【LOCK】保留饰品结构、石料排列、链节和主体比例；保留图一人物五官、肤色、发型、姿态与背景。\n\n【OUTPUT】佩戴效果自然，饰品主体清楚完整，光泽与图一照明统一。\n\n【EXCLUDE】不新增珠石，不把链条融入皮肤，不重复生成多件饰品。",
  },
  {
    id: "product-lifestyle-scene", title: "商品场景 · 换背景不改产品", category: "场景与展示", targetTool: "image-edit", tags: ["场景", "产品摄影", "氛围"], sources: [edit, compose],
    notes: "上传商品图；替换[场景描述]。",
    prompt: "【TARGET】将图一商品展示在[场景描述]中，商品仍是画面主体。\n\n【CHANGE】背景、承托表面和少量陪衬服务于该场景。按照场景光源调整商品表面的光影，使落地接触、透视、尺度和投影一致；陪衬不遮挡商品关键部位。\n\n【LOCK】保留商品形状、部件数量、颜色、可见材料、文字与图案关系。\n\n【OUTPUT】商业产品摄影效果，主体清楚，环境有层次，整体色调协调。\n\n【EXCLUDE】不换款、不改标识，不把背景装饰画到商品表面。",
  },
  {
    id: "fabric-home-mockup", title: "面料应用 · 抱枕与家居", category: "场景与展示", targetTool: "image-edit", tags: ["家居", "面料", "抱枕"], sources: [references],
    notes: "图一上传家居场景，图二上传面料；替换[目标家居物件]。",
    prompt: "【TARGET】以图一为场景主图，只替换[目标家居物件]的表面面料，面料参考图二。\n\n【CHANGE】图二提供颜色、织纹和图案；面料沿目标物件的曲面、接缝、包边和褶皱贴合，图案尺度前后一致，透视与遮挡合理。\n\n【LOCK】保持图一物件形状、位置、体积、环境光线和其他家具不变；保留图二主要图案与颜色关系。\n\n【OUTPUT】一张自然的家居面料应用效果图，重点物件清楚可见。\n\n【EXCLUDE】不把新面料扩散到墙面、地面或未指定家具，不增加新物件。",
  },
  {
    id: "coordinated-accessory-set", title: "配套系列 · 同一设计语言", category: "服装与配饰", targetTool: "image-generation", tags: ["系列", "配套", "设计开发"], sources: [compose],
    notes: "替换[品类清单]、[主题]、[配色]和[材料特征]。",
    prompt: "【TARGET】围绕[主题]开发一组[品类清单]，形成统一但不重复的配套系列。\n\n【CHANGE】整组共享[配色]与[材料特征]，使用同一种核心装饰语言；根据各品类的结构调整装饰尺度、位置和功能，不把同一图形机械复制成完全相同的外观。\n\n【LOCK】配色关系、材料观感和核心主题保持一致，各单品结构清楚且可辨认。\n\n【OUTPUT】在简洁背景上分开展示所有单品，大小层级合理，互不遮挡，整体像一组完整设计提案。\n\n【EXCLUDE】不加入清单以外的品类，不添加品牌名、价格或说明文字。",
  },
  {
    id: "product-banner-layout", title: "产品横幅 · 留出文案空间", category: "场景与展示", targetTool: "image-edit", tags: ["横幅", "封面", "电商海报"], sources: [edit, compose],
    notes: "上传商品图；替换[商品位置]和[背景风格]。",
    prompt: "【TARGET】用图一商品制作横向宣传画面，商品放在[商品位置]，背景采用[背景风格]。\n\n【CHANGE】以商品为视觉焦点，用环境色、柔和光影和简洁构图营造展示氛围，在商品相对的一侧保留连续、干净的文案区域。\n\n【LOCK】保持商品轮廓、比例、配色、材质、原有文字与装饰数量。\n\n【OUTPUT】横向商业视觉，商品完整，留白清楚，适合后续另行排版。\n\n【EXCLUDE】画面不自动生成标题、标语、价格或水印，不让道具遮挡商品。",
  },
  {
    id: "video-product-subtle-motion", title: "5秒视频 · 商品自然微动", category: "视频动效", targetTool: "video", tags: ["图生视频", "商品展示", "5秒"], sources: [motion],
    notes: "上传商品图作为首帧，时长选5秒；适合毛衫、围巾、包袋等单品。",
    prompt: "以图片1为首帧，制作5秒简洁的商品展示视频。0-2秒：保持完整商品构图，机位平稳，只让柔软部分出现幅度很小的自然起伏；2-5秒：镜头缓慢推近至商品主体，让表面纹理和局部光泽逐渐清楚。延续首帧的背景、色调与光源方向。商品款式、颜色、图案、文字、五金数量和整体比例始终一致；硬质部件保持稳定。不增加人物、手、字幕、水印或新Logo。",
  },
  {
    id: "video-model-garment", title: "5秒视频 · 模特转身展示", category: "视频动效", targetTool: "video", tags: ["模特", "转身", "服装视频"], sources: [motion],
    notes: "上传模特上身图作为首帧，时长选5秒。",
    prompt: "以图片1为首帧，制作5秒服装模特展示视频。0-2秒：模特保持自然站姿，肩膀与衣摆轻微自然活动，眼神平静；2-5秒：模特缓慢向身体左侧转至轻微侧身，展示服装侧面轮廓，镜头保持稳定并轻轻推近。服装褶皱随转身自然变化，主体始终留在画面内。保持人物五官、发型、衣服款式、颜色、图案及原有光线一致，不新增动作道具，不生成字幕、水印或新Logo。",
  },
  {
    id: "video-texture-closeup", title: "5秒视频 · 材质细节特写", category: "视频动效", targetTool: "video", tags: ["纹理", "特写", "细节"], sources: [motion],
    notes: "上传材质或工艺细节图作为首帧，时长选5秒。",
    prompt: "以图片1为首帧，制作5秒材质细节视频。0-2秒：保持原图细节构图与焦点，柔和侧光显出表面纹理；2-5秒：镜头沿表面缓慢横向移动一小段，保持相近拍摄距离和连续清晰度，让细节层次逐步展现。只有镜头与自然反光轻微变化，材料本身不变形、不融化，针织线圈、绣线或金属部件的数量与相互关系保持稳定。延续首帧色彩，不添加文字、水印、人物或额外装饰。",
  },
];
