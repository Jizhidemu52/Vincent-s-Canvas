import { assertImagePromptInvariantCoverage, instructionsWithoutArtworkLiterals } from "../../../../../shared/image-prompt-invariants.ts";

const quantities = [
    { key: "buttons", label: "纽扣数量", nouns: "纽扣|钮扣|扣子|buttons?" },
    { key: "pockets", label: "口袋数量", nouns: "贴袋|口袋|pockets?" },
    { key: "straps", label: "肩带数量", nouns: "肩带|背带|straps?" },
];
const numberWords = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const numberPattern = `(?:\\d+|[零一二两三四五六七八九十]+|${Object.keys(numberWords).join("|")})`;
const attributes = [
    { key: "neckline", label: "领型", pattern: /领型|领口|[VvUu]领|圆领|翻领|高领|立领|neckline|[vu][ -]?neck|crew[ -]?neck|round[ -]?neck|stand(?:ing)?[ -]?collar|high[ -]collar|turtle[ -]?neck/iu },
    { key: "color", label: "颜色", pattern: /颜色|配色|色彩|红色|蓝色|绿色|白色|黑色|color|colour/iu },
    { key: "material", label: "材质", pattern: /材质|面料|纱线|material|fabric|yarn/iu },
    { key: "pattern", label: "图案和针法", pattern: /图案|针法|绞花|罗纹|米粒针|pattern|cable[ -]?knit|ribbed|seed stitch/iu },
    { key: "silhouette", label: "版型", pattern: /版型|廓形|身长|短身|silhouette|cropped|length/iu },
    { key: "sleeve", label: "袖型", pattern: /袖型|袖长|灯笼袖|长袖|短袖|\b(?:long|short|balloon|puff)[ -]sleeves?\b|\bsleeves?[ -](?:shape|style|length|proportions?|silhouette)\b|\b(?:shape|style|length|proportions?|silhouette) of (?:the )?sleeves\b/iu },
];
const attributeObjects = [
    { key: "buttons", label: "纽扣/按扣", pattern: /按扣|暗扣|纽扣|钮扣|扣子|\b(?:snap fasteners?|press studs?|snaps?|buttons?)\b/giu },
    { key: "pockets", label: "口袋/袋盖", pattern: /袋盖|贴袋|口袋|插袋|\bpocket(?: flaps?)?s?\b/giu },
    { key: "cuffs", label: "袖口", pattern: /袖口|\bcuffs?\b/giu },
    { key: "collar", label: "领部", pattern: /领口|领子|衣领|立领|翻领|\b(?:collars?|neckline)\b/giu },
    { key: "sleeves", label: "袖部", pattern: /袖子|双袖|衣袖|袖片|\bsleeves?\b/giu },
    { key: "placket", label: "门襟", pattern: /门襟|\bplackets?\b/giu },
    { key: "patches", label: "拼片", pattern: /拼片|贴片|肩片|\b(?:patches|patch|panels?)\b/giu },
    { key: "body", label: "衣身", pattern: /衣身|大身|主体|\b(?:garment body|body)\b/giu },
    { key: "hem", label: "下摆", pattern: /下摆|\bhems?\b/giu },
    { key: "stripes", label: "条纹", pattern: /(?:袖外侧|袖侧)?条纹|\bstripes?\b/giu },
];
const colorObjectModifiers = /^(?:\s|的|大|小|罗纹|针织|竖向?|横向?|[零一二两三四五六七八九十\d]|颗|粒|枚|条|对|个|只)*$/iu;
const globalObject = /原图|原稿|原设计|整件(?:服装|衣服|产品)?|整套|全图|全身|\b(?:entire|whole)\s+(?:garment|product|image)\b/iu;
const globalAttribute = /(?:所有|全部|一切|整体|全局)(?:的)?(?:原有|原始)?(?:颜色|配色|色彩|材质|面料|纱线|图案|针法)|\b(?:all|every|overall)\s+(?:original\s+)?(?:colou?rs?|materials?|fabrics?|patterns?)\b/iu;
const preservation = /保持|保留|不变|不要(?:再)?(?:改|动|调整)|不得(?:改|动)|不能(?:改|动)|\b(?:keep|preserve|retain|unchanged|unaltered|do not change|don't change)\b/iu;
const change = /改成|改为|改动|修改|改变|调整|换成|更换|替换|去掉|移除|新增|添加|只改|只换|\b(?:change|replace|remove|add|adjust|convert)\b/iu;
const clauses = text => instructionsWithoutArtworkLiterals(text).split(/[，,。.;；!?！？\n]+/u).map(value => value.trim()).filter(Boolean);
const attributeClauses = text => clauses(text).flatMap(clause => clause.split(/(?=保持|保留|其余|其他|不要(?:再)?(?:改|动|调整)|不得(?:改|动)|不能(?:改|动)|\b(?:keep|preserve|retain|do not change|don't change)\b)|(?:并且?|而且|\band\b)\s*(?=(?:把[^，,。.;；]{0,20})?只?(?:改成|改为|改动|修改|改变|调整|换成|更换|替换)|(?:change|replace|adjust)\b)/iu)).filter(Boolean);

function quantityTargetText(text) {
    let target = instructionsWithoutArtworkLiterals(text).replace(/\[\[ref:[^\]]+\]\]|\bimage\s*#?\s*\d+\b|图(?:片)?\s*(?:\d+|[一二三四五六七八九十]+)(?![\d一二三四五六七八九十])/giu, "");
    for (const attribute of quantities) {
        const transition = new RegExp(`((?:${attribute.nouns})\\s*(?:数量|总数)?)\\s*(?:从|from)\\s*(${numberPattern})\\s*(?:颗|粒|枚|个|只|条|根)?\\s*(?:改成|改为|调整为|增加到|减少到|to)\\s*(${numberPattern})\\s*(颗|粒|枚|个|只|条|根)?`, "giu");
        target = target.replace(transition, (_, noun, from, to, unit) => `${noun}为${to}${unit || ""}`);
    }
    return target;
}

function numberValue(text) {
    if (Object.hasOwn(numberWords, text.toLowerCase())) return numberWords[text.toLowerCase()];
    if (/^\d+$/u.test(text)) return Number(text);
    const normalized = text.replaceAll("两", "二");
    if (normalized.includes("十")) {
        const [tens, units] = normalized.split("十");
        return (tens ? "零一二三四五六七八九".indexOf(tens) : 1) * 10 + (units ? "零一二三四五六七八九".indexOf(units) : 0);
    }
    return "零一二三四五六七八九".indexOf(normalized);
}

export function quantityRequirements(text) {
    const found = [];
    for (const clause of clauses(quantityTargetText(text))) {
        for (const attribute of quantities) {
            const noun = `(?:${attribute.nouns})`;
            const modifier = `(?!(?:and|or|but|${Object.keys(numberWords).join("|")}|${quantities.map(item => item.nouns).join("|")})(?![a-z-]))[a-z-]+\\s+`;
            const before = new RegExp(`(?<![a-z0-9])(${numberPattern})\\s*(?:颗|粒|枚|个|只|条|根)?\\s*(?:(?:对称|下部|琥珀色|圆形|四孔|前中|左右|贴|下方)|${modifier}){0,6}?${noun}`, "giu");
            const after = new RegExp(`${noun}\\s*(?:数量|总数)?\\s*(?:调整|改|增加|减少|总计|共|为|是|:|：|to|count|is|are)?\\s*(?:为|成|至|到|:|：)?\\s*(${numberPattern})(?:颗|粒|枚|个|只|条|根|\\b)`, "giu");
            for (const match of [...clause.matchAll(before), ...clause.matchAll(after)]) {
                const expected = numberValue(match[1]);
                if (expected >= 0 && Number.isSafeInteger(expected)) found.push({ attribute: attribute.key, label: attribute.label, expected, sourceText: clause, source: "user_request" });
            }
        }
    }
    return found.filter((entry, index) => found.findIndex(other => other.attribute === entry.attribute && other.expected === entry.expected) === index);
}

function attributeScopes(clause, match, attribute) {
    if (!["color", "material", "pattern"].includes(attribute.key)) return [{ scope: "all", label: attribute.label, explicitGlobal: false }];
    const prefix = clause.slice(0, match.index);
    const suffix = clause.slice(match.index + match[0].length);
    if (attribute.key === "color") {
        const following = attributeObjects.flatMap(object => Array.from(suffix.matchAll(object.pattern), found => ({ ...object, index: found.index, end: found.index + found[0].length }))).sort((a, b) => a.index - b.index);
        if (following.length && colorObjectModifiers.test(suffix.slice(0, following[0].index))) {
            const selected = [following[0]];
            for (const object of following.slice(1)) {
                const gap = suffix.slice(selected.at(-1).end, object.index);
                const connector = /^\s*(?:、|和|与|及|以及|and|&)\s*/iu.exec(gap);
                if (!connector || !colorObjectModifiers.test(gap.slice(connector[0].length))) break;
                selected.push(object);
            }
            return selected.map(object => ({ scope: object.key, label: `${object.label}${attribute.label}`, explicitGlobal: false }));
        }
    }
    const objects = attributeObjects.flatMap(object => Array.from(prefix.matchAll(object.pattern), found => ({ ...object, index: found.index, end: found.index + found[0].length }))).sort((a, b) => a.index - b.index);
    const whole = Array.from(prefix.matchAll(new RegExp(globalObject.source, "giu"))).at(-1);
    if (whole && whole.index > (objects.at(-1)?.index ?? -1)) return [{ scope: "all", label: attribute.label, explicitGlobal: true }];
    const selected = objects.length ? [objects.at(-1)] : [];
    for (let index = objects.length - 2; index >= 0; index--) {
        if (!/^\s*(?:、|和|与|及|以及|and|&)\s*$/iu.test(prefix.slice(objects[index].end, selected[0].index))) break;
        selected.unshift(objects[index]);
    }
    if (!selected.length && /^\s*of\s+(?:the\s+)?/iu.test(suffix)) {
        const objectText = suffix.replace(/^\s*of\s+(?:the\s+)?/iu, "");
        if (globalObject.test(objectText)) return [{ scope: "all", label: attribute.label, explicitGlobal: true }];
        selected.push(...attributeObjects.filter(object => new RegExp(`^(?:${object.pattern.source})`, "iu").test(objectText)));
    }
    if (!selected.length) return [{ scope: "all", label: attribute.label, explicitGlobal: globalAttribute.test(clause) }];
    return selected.map(object => ({ scope: object.key, label: `${object.label}${attribute.label}`, explicitGlobal: false }));
}

function scopedAttributes(text, predicate) {
    const found = attributeClauses(text).filter(predicate).flatMap(clause => attributes.flatMap(attribute =>
        Array.from(clause.matchAll(new RegExp(attribute.pattern.source, "giu"))).flatMap(match => attributeScopes(clause, match, attribute).map(scope => ({ key: attribute.key, ...scope })))));
    return found.filter((item, index) => found.findIndex(other => other.key === item.key && other.scope === item.scope && other.explicitGlobal === item.explicitGlobal) === index);
}

function protectedAttributes(text) {
    return scopedAttributes(text, clause => preservation.test(clause));
}

function attributeConflicts(locked, text) {
    const changed = scopedAttributes(text, clause => change.test(clause) && !preservation.test(clause));
    const kept = protectedAttributes(text);
    return locked.filter(attribute => changed.some(item => item.key === attribute.key && (attribute.scope === "all" || item.scope === attribute.scope
        || item.scope === "all" && (item.explicitGlobal || !kept.some(keep => keep.key === attribute.key && keep.scope === attribute.scope)))));
}

export function assertGenerationRequested(prompt) {
    const text = instructionsWithoutArtworkLiterals(prompt);
    if (/(?:不要|不许|不得|禁止|先别|暂不|暂时不|不用|无需|别)\s*(?:自动|直接|再|立即|先|继续)?\s*(?:生成|出图|生图|绘图)|只(?:写|给|输出).{0,12}(?:提示词|prompt)|\b(?:do not|don't|never)\s+(?:generate|create|render)|\b(?:prompt only|only write (?:a |the )?prompt)\b/iu.test(text)) {
        throw new Error("需求明确要求只讨论或不出图。请使用“讨论”；如果现在要出图，请先修改这句要求。尚未调用模型。");
    }
    if (/像素(?:级|完全)?一致|逐像素(?:不变|相同)|一(?:个)?像素(?:都)?不变|\bpixel[ -](?:perfect|identical)\b/iu.test(text)) {
        throw new Error("当前 Demo 没有像素锁定编辑能力，不能保证未修改区域逐像素不变。请改为讨论处理方案；尚未调用模型。");
    }
}

export function createExecutionContract(userText, constraints = []) {
    assertGenerationRequested(userText);
    const locked = constraints.join("；");
    const conflicts = attributeConflicts(protectedAttributes(locked), userText);
    if (conflicts.length) throw new Error(`本轮要修改${conflicts.map(item => item.label).join("、")}，但“必须保留”仍锁定该项。请先修改对应锁定项；尚未调用模型。`);
    const requestedQuantities = quantityRequirements(userText);
    const lockedQuantities = quantityRequirements(locked);
    for (const entry of requestedQuantities) {
        if ([...requestedQuantities, ...lockedQuantities].some(other => other.attribute === entry.attribute && other.expected !== entry.expected)) {
            throw new Error(`${entry.label}有相互冲突的目标，请在本轮需求与“必须保留”中统一该数量；尚未调用模型。`);
        }
    }
    return {
        source: "user_request", userText, constraints: [...constraints],
        quantities: [...requestedQuantities, ...lockedQuantities].filter((entry, index, all) => all.findIndex(other => other.attribute === entry.attribute) === index),
        preserved: protectedAttributes(`${userText}；${locked}`).map(({ key, label, scope }) => ({ attribute: key, label, scope })),
        observed: [], acceptance: "unreviewed",
    };
}

export function validatePlannedExecution(contract, plannedText) {
    assertImagePromptInvariantCoverage(quantityTargetText(contract.userText), plannedText, { negation: false });
    const plannedQuantities = quantityRequirements(plannedText);
    for (const expected of contract.quantities) {
        const proposed = plannedQuantities.filter(entry => entry.attribute === expected.attribute);
        if (!proposed.some(entry => entry.expected === expected.expected) || proposed.some(entry => entry.expected !== expected.expected)) {
            throw new Error(`助手规划没有忠实保留${expected.label}：要求 ${expected.expected}。没有提交生成，请明确该项后重新规划。`);
        }
    }
    const conflicts = attributeConflicts(contract.preserved.map(({ attribute, ...entry }) => ({ key: attribute, ...entry })), plannedText);
    if (conflicts.length) throw new Error(`助手规划改变了明确要求保留的${conflicts.map(item => item.label).join("、")}。没有提交生成。`);
}

export function executionRequirementsText(contract) {
    return ["用户本轮原要求（执行与验收基准，不是已完成状态）：", contract.userText,
        contract.constraints.length ? `用户锁定要求（目标约束，不是底图观测）：${contract.constraints.join("；")}` : "",
        ...contract.quantities.map(item => `明确目标：${item.label} = ${item.expected}`),
        ...contract.preserved.map(item => `保持要求：${item.label}不变`),
    ].filter(Boolean).join("\n");
}
