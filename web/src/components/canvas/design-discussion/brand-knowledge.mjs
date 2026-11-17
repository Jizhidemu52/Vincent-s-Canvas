export const BRAND_KNOWLEDGE_VERSION = "2026-11-17.1";
const source = (title, url) => ({ title, url, checkedAt: "2026-11-17", evidence: "官方页面文字与商品描述；不是跨季完整视觉研究" });
export const BRAND_KNOWLEDGE = {
    HM: {
        name: "H&M", aliases: ["HM", "H&M"], scope: "美国站童装小配饰、一个女装针织样本；名单 HM 暂按 H&M 对应，其他含义应改选。",
        observed: ["童帽目录重复出现罗纹、贴饰、绞花、毛球以及帽子加围脖套装，并包含羊毛与棉质款。", "女装样本 1300276002 标注宽松罗纹、落肩和围巾领；不能把这一款当全部女装风格。"],
        proposal: { 色彩: "按客群选择基础色组，加一个主题色，不固定每季色盘", 材质: "区分棉、羊毛与混纺方向，生成效果不证明成分", 纹样: "基础罗纹与一个小型识别细节二选一做主角", 结构: "帽型和围脖截面协调，服装可借领口或袖口针法呼应", 装饰: "控制贴饰尺度，不擅自添加商标或授权角色" },
        translation: "童装小商品可从帽与围脖套系展开；女装只借针织组织/领口关系，不照搬童趣贴饰。男装仍缺专门样本。",
        sources: [source("H&M 童帽目录", "https://www2.hm.com/en_us/kids/products/accessories/hats/beanies.html"), source("H&M 围巾领针织衫", "https://www2.hm.com/en_us/productpage.1300276002.html")],
    },
    Zara: {
        name: "Zara", aliases: ["Zara"], scope: "美国站童配饰、男装 Autumn Wardrobe 与一款棉针织衫；不等同所有子线。",
        observed: ["童配饰目录包含刺绣针织帽、三角围巾、罗纹帽与交叉罗纹围领。", "男装 Autumn Wardrobe 同时展示绞花毛衣、罗纹帽和羊毛羊绒混纺围巾；棉针织样本 5629/563 有系结领与撞色边。"],
        proposal: { 色彩: "以一组主体色和局部对比色组织造型，不把网页当全市场趋势", 材质: "优先在针法、毛感或色差里选一个变化焦点", 纹样: "基本组织与局部刺绣分主次，不混用不同子线全部元素", 结构: "可探索围领、三角围巾或帽口比例，必须在本轮改款授权内", 装饰: "变化集中在轮廓或边缘，避免无目的堆叠" },
        translation: "男装用毛衣、帽子、围巾的组织和体量呼应；童装可缩小装饰尺度；不把联名图案迁移为自有花型。",
        sources: [source("Zara 童配饰", "https://www.zara.com/us/en/kids-girl-accessories-headwear-l332.html"), source("Zara 男装 Autumn Wardrobe", "https://www.zara.com/us/en/man-event-l606.html?v1=2563447"), source("Zara 棉针织衫样本", "https://www.zara.com/us/en/100-cotton-knit-sweater-with-scarf-detail-p05629563.html")],
    },
    Next: {
        name: "Next", aliases: ["Next"], scope: "英国站儿童围脖/围巾；平台也销售其他品牌，不能把全站商品归为 Next 自有品牌。",
        observed: ["儿童围巾目录同时展示素色罗纹围脖、保暖针织围脖与动物角色围巾，并标年龄段。", "自有款 B17-206 是标注 1–16 岁的罗纹针织围脖，成分为再生聚酯；该旧款页面价格记录不能代表当前价位。"],
        proposal: { 色彩: "可做基础素色与主题色两条方向，依据客户选定年龄段细化", 材质: "强调贴肤触感和保暖表现，不从照片推断精确成分", 纹样: "素色针法与动物主题作为不同支线，不强行混搭", 结构: "按年龄段讨论围脖体量和帽型，不能一套比例通用", 装饰: "主题元素控制在易识别位置，具体安全与工艺需另行验证" },
        translation: "先围绕儿童帽子与围脖形成配套，再把相同针法/色彩映射到服装边缘；男装女装需补专门资料。",
        sources: [source("Next 儿童围巾目录", "https://www.next.co.uk/shop/childrens/accessories/hats-gloves-scarves/scarves"), source("Next B17-206 围脖", "https://www.next.co.uk/style/su285234/b17206")],
    },
    Primark: {
        name: "Primark", aliases: ["Primark"], scope: "英国与美国站儿童冬季小配饰快照；不将地区售价用于成本承诺。",
        observed: ["儿童目录可见帽与围脖套装、三件套、素色罗纹帽、绞花毛球帽和动物细节。", "目录也列有 The Edit 羊毛款与授权角色款；不同系列不能统一假设材质或授权范围。"],
        proposal: { 色彩: "用容易成套的主辅色控制 SKU 关系，具体颜色由客户简报决定", 材质: "把普通基础款与羊毛支线分别讨论，不强制同一材料", 纹样: "以罗纹/绞花等清楚结构为底，再选一项主题细节", 结构: "优先让帽与围脖的宽度、边缘组织和毛感有共同语言", 装饰: "减少不必要工序是提案目标，不声称已核实成本；不复制授权角色" },
        translation: "适合先研究帽、围脖等小套系的产品关系；成人服装开发需要另外的对应品类样本。",
        sources: [source("Primark 英国儿童帽围巾", "https://www.primark.com/en-gb/r/kids/browse-by-product/accessories/hats-gloves-and-scarves"), source("Primark 美国儿童帽围巾", "https://www.primark.com/en-us/r/kids/shop-by-product/accessories/hats-gloves-and-scarves")],
    },
    Quince: {
        name: "Quince", aliases: ["Quince"], scope: "美国站成人羊绒帽围巾目录；童装尚未研究。",
        observed: ["男女小配饰目录重复出现羊绒罗纹帽、围巾、围脖和格纹围巾。", "页面列有灰、黑、燕麦、海军蓝等基础色，也有酒红、青绿等颜色；不能概括为只做中性色。"],
        proposal: { 色彩: "优先建立可搭配的基础色，再有选择地加入深色点缀", 材质: "让纱线质感和织物组织承担设计重点，效果图不证明羊绒等级", 纹样: "罗纹、绞花或格纹有主次，避免所有肌理叠加", 结构: "关注帽口高度、围脖体量与针织衫领口的配合", 装饰: "优先靠组织和比例变化，不默认添加显眼标志" },
        translation: "成人帽围脖可复用毛衣的色系和针法，不直接照搬成人比例到儿童；成分和成本由真实供应资料决定。",
        sources: [source("Quince 女士羊绒小配饰", "https://www.quince.com/shop/women/hats-%26-scarves?filters=materials_cashmere"), source("Quince 男士帽围巾", "https://www.quince.com/shop/men/hats-scarves-%26-gloves")],
    },
    "Massimo Dutti": {
        name: "Massimo Dutti", aliases: ["Massimo Dutti"], scope: "成人针织围巾/围领样本，包含有限系列；不推断童装或全年风格。",
        observed: ["围巾目录同时列出羊毛羊绒绞花、细针织、羊驼毛混纺罗纹及羊绒三角巾。", "样本 2691/330 为素面羊毛混纺流苏围巾；6398/555 为羊毛羊绒罗纹包裹式围领。"],
        proposal: { 色彩: "先建立同色层次和材质对比，红、绿等点缀依据客户简报选择", 材质: "细针、罗纹、绞花的精细度与垂感分别表达，不都渲染成粗毛线", 纹样: "用组织或格外清晰的结构形成重点，避免无依据密集贴饰", 结构: "围领可与毛衣领部和外套形成层次，保持佩戴可行", 装饰: "流苏与收边可作细节，数量和尺寸不凭空当生产规格" },
        translation: "以成人针织衫与帽围脖的材质、体量、边缘形成系列；童装方向不从此资料自动推导。",
        sources: [source("Massimo Dutti 围巾目录", "https://www.massimodutti.com/fi/women/accessories/scarf-n2991"), source("Massimo Dutti 素面流苏围巾", "https://www.massimodutti.com/es/en/wool-blend-scarf-with-fringing-l02691330"), source("Massimo Dutti 罗纹围领", "https://www.massimodutti.com/us/woolcashmere-knit-infinity-scarf--limited-edition-l06398555")],
    },
};

export function selectedBrandKnowledge(brief = {}, prompt = "") {
    const mentioned = Object.entries(BRAND_KNOWLEDGE).filter(([key, card]) => card.aliases.some(alias => {
        if (key === "Next" && !/[\u3400-\u9fff]/u.test(prompt) && !/(?:@next|brand\s+next|next\s+brand)/i.test(prompt) && prompt.trim().toLowerCase() !== "next") return false;
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(prompt);
    }));
    const selected = mentioned.length ? mentioned : BRAND_KNOWLEDGE[brief.brand] ? [[brief.brand, BRAND_KNOWLEDGE[brief.brand]]] : [];
    return selected.slice(0, 3).map(([key, card]) => ({ key, ...card }));
}

export function brandKnowledgeMessage(brief, prompt) {
    const cards = selectedBrandKnowledge(brief, prompt);
    return cards.length ? `品牌资料版本 ${BRAND_KNOWLEDGE_VERSION}。以下为带来源的局部研究，不是永久品牌 DNA 或已验证审美；observed 为官方文本事实，proposal 与 translation 为本 Demo 的设计推断，需服从用户本轮意图。并非实时检索；资料时间不等于季节标签。超过三个品牌时仅列前三个资料卡，不声称其他已研究。\n${JSON.stringify(cards)}` : "本轮未命中已整理的品牌资料；不编造已研究、已训练或实时趋势。";
}
