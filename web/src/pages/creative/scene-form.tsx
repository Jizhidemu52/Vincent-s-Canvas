import { ImagePlus, Palette, Plus, Trash2, Upload } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type { ReferenceImage } from "@/types/image";
import { useModuleEnabled } from "@/stores/use-module-store";
import { addSceneColor, CONCEPT_COUNTS, getSceneColorSelection, isSceneHexColor, OUTFIT_CATEGORIES, removeSceneColor, setSceneColor, type SceneForm, type SceneSlot, type SceneSlotId } from "./scene-form-model";

const StandardColorDialog = lazy(() => import("./standard-color-dialog"));

type SceneFieldsProps = {
    sceneId: string;
    form: SceneForm;
    onChange: (next: SceneForm) => void;
    disabled?: boolean;
    sourceImage?: string;
};
type TextField = { [K in keyof SceneForm]-?: SceneForm[K] extends string ? K : never }[keyof SceneForm];
type NumberField = { [K in keyof SceneForm]-?: SceneForm[K] extends number ? K : never }[keyof SceneForm];

function Choices({ id, label, value, options, onChange, disabled }: {
    id: string;
    label: string;
    value: string;
    options: readonly (string | { value: string; label: string })[];
    onChange: (value: string) => void;
    disabled?: boolean;
}) {
    return <fieldset className="cs-field" disabled={disabled}>
        <legend className="cs-label">{label}</legend>
        <div className="cs-choice-group">
            {options.map((option) => {
                const item = typeof option === "string" ? { value: option, label: option } : option;
                return <label key={item.value} className={`cs-choice${value === item.value ? " is-active" : ""}`}>
                    <input className="cs-choice-input" type="radio" name={id} value={item.value} checked={value === item.value} disabled={disabled} onChange={() => onChange(item.value)} />
                    <span>{item.label}</span>
                </label>;
            })}
        </div>
    </fieldset>;
}

function colorPickerValue(color: string): string {
    const value = color.trim();
    if (!isSceneHexColor(value)) return "#808080";
    return value.length === 4 ? `#${value.slice(1).split("").map((part) => part + part).join("")}` : value;
}

export function SceneFields({ sceneId, form, onChange, disabled = false, sourceImage }: SceneFieldsProps) {
    const [colorSlot, setColorSlot] = useState<number | null>(null);
    const colorLibraryEnabled = useModuleEnabled("standard-colors");
    const id = (name: string) => `cs-${sceneId}-${name}`;
    const update = <K extends keyof SceneForm>(key: K, value: SceneForm[K]) => onChange({ ...form, [key]: value });
    const choice = (key: TextField, label: string, options: readonly (string | { value: string; label: string })[]) => <Choices
        id={id(key)} label={label} value={String(form[key])} options={options} disabled={disabled}
        onChange={(value) => update(key, value as SceneForm[typeof key])}
    />;
    const countChoice = (key: NumberField, label: string, options: readonly number[]) => <Choices
        id={id(key)} label={label} value={String(form[key])} options={options.map(value => ({ value: String(value), label: String(value) }))} disabled={disabled}
        onChange={value => update(key, Number(value))}
    />;
    const textField = (key: TextField, label: string, placeholder: string, required = false) => <div className="cs-field">
        <label className="cs-label" htmlFor={id(key)}>{label}{required && <span className="cs-required" aria-hidden="true"> *</span>}</label>
        <input id={id(key)} className="cs-input" value={form[key]} onChange={event => update(key, event.target.value as SceneForm[typeof key])} maxLength={1000} placeholder={placeholder} required={required} disabled={disabled} />
    </div>;
    const numberField = (key: NumberField, label: string, min: number, max: number, step = 1) => <div className="cs-field">
        <label className="cs-label" htmlFor={id(key)}>{label}</label>
        <input id={id(key)} className="cs-input" type="number" value={form[key]} min={min} max={max} step={step} onChange={event => update(key, Number(event.target.value))} disabled={disabled} />
    </div>;
    const categoryField = <div className="cs-field">
        <label className="cs-label" htmlFor={id("category")}>目标服装品类</label>
        <select id={id("category")} className="cs-select" value={form.category} onChange={event => update("category", event.target.value)} disabled={disabled}>
            {["按描述判断", "上衣", "衬衫", "针织衫", "外套", "连衣裙", "半裙", "长裤", "短裤", "其他服装"].map(item => <option key={item}>{item}</option>)}
        </select>
    </div>;
    const presentationField = choice("presentation", "展示方式", ["白底平铺", "模特展示", "设计效果图", "参考图一致"]);
    const boardFields = <>
        {countChoice("conceptCount", "方案板内款数", CONCEPT_COUNTS)}
        <p className="cs-help">款数决定一张方案板里的设计数量；生成张数决定独立输出多少张方案板。</p>
        {presentationField}
    </>;
    const fusionFields = <>
        {textField("fusionRole1", "图一负责什么", "如：整体廓形与比例", true)}
        {textField("fusionRole2", "图二负责什么", "如：袖型、面料或装饰细节", true)}
        {numberField("fusionWeight", "图一参考侧重（%）", 10, 90, 10)}
        <p className="cs-help">图二侧重 {100 - form.fusionWeight}%。侧重用于描述设计偏好，两图指定要素都应出现在结果中。</p>
        {textField("preserve", "必须保留的元素", "如：图一轮廓与图二花朵形状")}
    </>;
    const textureFields = <>
        {numberField("patternScale", "图案或纹理视觉比例（倍）", .25, 4, .25)}
        {choice("patternDirection", "图案或纹理方向", ["保持参考方向", "旋转 90°", "旋转 180°", "随衣片自然排列"])}
    </>;
    const descriptionField = (label: string, placeholder: string, required = false) => <div className="cs-field">
        <label className="cs-label" htmlFor={id("description")}>{label}{required && <span className="cs-required" aria-hidden="true"> *</span>}</label>
        <textarea id={id("description")} className="cs-textarea" value={form.description} onChange={(event) => update("description", event.target.value)} rows={required ? 4 : 2} maxLength={4000} placeholder={placeholder} required={required} disabled={disabled} />
    </div>;
    const extra = (placeholder: string) => <details className="cs-details">
        <summary>补充说明（可选）{form.description.trim() ? <span className="cs-details-status">已填写</span> : null}</summary>
        {descriptionField("具体要求", placeholder)}
    </details>;
    const colorFields = <>
        {choice("colorMode", "配色方式", [{ value: "smart", label: "智能配色" }, { value: "specific", label: "指定颜色" }, { value: "reference", label: "参考图配色" }])}
        {form.colorMode === "smart" && <>
            {choice("colorMood", "配色方向", ["自然柔和", "清爽明亮", "沉稳经典", "强烈对比"])}
            <p className="cs-help">根据原图的色块关系生成一套新配色。</p>
        </>}
        {form.colorMode === "specific" && <div className="cs-field">
            <div className="cs-label" id={id("palette-label")}>目标色板 <span className="cs-help">{form.colors.length} / 6 色</span></div>
            <div className="cs-palette" role="group" aria-labelledby={id("palette-label")}>
                {form.colors.map((color, index) => {
                    const selected = getSceneColorSelection(form, index);
                    return <div className="cs-color-entry" key={index}>
                        <div className="cs-color-row">
                            <input type="color" className="cs-color-picker" aria-label={`选择颜色 ${index + 1}`} value={colorPickerValue(color)} disabled={disabled} onChange={(event) => onChange(setSceneColor(form, index, event.target.value.toUpperCase()))} />
                            <input id={id(`color-${index}`)} className="cs-input cs-color-input" aria-label={`颜色 ${index + 1} HEX 色值`} aria-invalid={!isSceneHexColor(color)} type="text" value={color} spellCheck={false} autoComplete="off" maxLength={7} disabled={disabled} placeholder="#RRGGBB" onChange={(event) => onChange(setSceneColor(form, index, event.target.value))} />
                            {colorLibraryEnabled && sceneId === "garment-colorway" && <button type="button" className="cs-color-library" aria-label={`从标准色库选择颜色 ${index + 1}`} title="从标准色库选择" disabled={disabled} onClick={() => setColorSlot(index)}><Palette size={14} aria-hidden="true" /><span>色库</span></button>}
                            <button type="button" className="cs-color-remove" aria-label={`删除颜色 ${index + 1}`} disabled={disabled} onClick={() => onChange(removeSceneColor(form, index))}><Trash2 size={14} aria-hidden="true" /></button>
                        </div>
                        {selected && <div className="cs-color-source"><span title={`${selected.library} · ${selected.name}`}>{selected.library} · {selected.name}</span><a href={selected.sourceUrl} target="_blank" rel="noreferrer" aria-label={`查看颜色 ${index + 1} 来源`}>来源</a></div>}
                    </div>;
                })}
                <button type="button" className="cs-add-color" disabled={disabled || form.colors.length >= 6} onClick={() => onChange(addSceneColor(form))}><Plus size={14} aria-hidden="true" />添加颜色</button>
            </div>
            <p className="cs-help">点击色块选色，或填写 #RGB / #RRGGBB。生成颜色为近似效果。</p>
        </div>}
        {form.colorMode === "reference" && <p className="cs-help">请在「配色参考图」上传第二张图片，仅参考其中的色彩搭配。</p>}
        <div className="cs-field">
            <label className="cs-label" htmlFor={id("colorRegion")}>改色区域 <span className="cs-help">可选</span></label>
            <input id={id("colorRegion")} className="cs-input" value={form.colorRegion} onChange={(event) => update("colorRegion", event.target.value)} maxLength={500} disabled={disabled} placeholder={sceneId === "garment-colorway" ? "如：仅大身，保留袖口与领口颜色" : "如：仅花瓣与叶片，保留底色"} />
        </div>
        {extra(sceneId === "garment-colorway" ? "如：领口滚边继续使用原色。" : "如：深色线条保持不变，让花瓣更柔和。")}
    </>;

    let fields;
    switch (sceneId) {
        case "series-extension":
        case "bestseller-proposal":
            fields = <>
                {countChoice("referenceCount", "系列参考图数量", [1, 2, 3, 4])}
                {sceneId === "series-extension" && categoryField}
                {textField("preserve", "系列共同设计元素", "如：米白粗呢、花朵贴饰与黑色滚边")}
                {boardFields}
                {extra(sceneId === "series-extension" ? "如：围绕相同面料发展不同领型与下摆。" : "如：以核心半裙为主，搭配不同上装与配饰。")}
            </>;
            break;
        case "detail-to-style":
        case "fabric-to-style":
            fields = <>
                {categoryField}
                {textField("targetStyle", "品牌或风格方向", "如：简约通勤、轻松度假", true)}
                {sceneId === "detail-to-style" && textField("referenceDetail", "需要继承的局部细节", "如：三角翻折袋口与枝条刺绣")}
                {boardFields}
                {extra(sceneId === "detail-to-style" ? "如：每款都清楚呈现参考袋口，变化衣身版型。" : "如：面料用于整个衣身，强调轻薄垂感。")}
            </>;
            break;
        case "reference-to-style":
            fields = <>
                {choice("referenceMode", "参考改款方式", [{ value: "category", label: "改品类" }, { value: "style", label: "改风格" }, { value: "detail", label: "改部件" }, { value: "custom", label: "自定义" }])}
                {form.referenceMode === "category" && categoryField}
                {form.referenceMode === "style" && textField("targetStyle", "目标风格", "如：复古学院风", true)}
                {form.referenceMode === "detail" && textField("referenceDetail", "参考部件与改动", "如：保留帽子，胸贴袋改为斜插袋", true)}
                {form.referenceMode === "custom" ? descriptionField("自定义改款要求", "写清要修改的结构、配色、面料与细节。", true) : extra("如：整体比例保持原款，面料不变。")}
                {textField("preserve", "必须保留的设计", "如：帽子、门襟、面料和原配色")}
            </>;
            break;
        case "style-fusion":
            fields = <>
                {categoryField}
                {fusionFields}
                {presentationField}
                {extra("如：图一裙摆结合图二扭结细节，不增加多余装饰。")}
            </>;
            break;
        case "outfit-design":
            fields = <>
                <div className="cs-field-row">
                    <div className="cs-field">
                        <label className="cs-label" htmlFor={id("outfitCategory")}>搭配品类</label>
                        <select id={id("outfitCategory")} className="cs-select" value={form.outfitCategory} disabled={disabled} onChange={event => onChange({ ...form, outfitCategory: event.target.value, outfitSubcategory: OUTFIT_CATEGORIES[event.target.value]![0]! })}>
                            {Object.keys(OUTFIT_CATEGORIES).map(item => <option key={item}>{item}</option>)}
                        </select>
                    </div>
                    <div className="cs-field">
                        <label className="cs-label" htmlFor={id("outfitSubcategory")}>搭配子类</label>
                        <select id={id("outfitSubcategory")} className="cs-select" value={form.outfitSubcategory} disabled={disabled} onChange={event => update("outfitSubcategory", event.target.value)}>
                            {(OUTFIT_CATEGORIES[form.outfitCategory] || []).map(item => <option key={item}>{item}</option>)}
                        </select>
                    </div>
                </div>
                <p className="cs-help">保留上传单品，新增一件所选子类的搭配款，展示完整套装。</p>
                {presentationField}
                {extra("如：新增外套使用原半裙的格纹，版型短而利落。")}
            </>;
            break;
        case "apply-pattern":
        case "pattern-fill":
            fields = <>
                {textField("placement", sceneId === "apply-pattern" ? "定位图案位置" : "铺设衣片", sceneId === "apply-pattern" ? "如：前胸居中" : "如：前后大身，保留领口袖口素色", true)}
                {textureFields}
                <p className="cs-help">图案来自图片2；需要严格控制修改范围时，在服装原图上涂选目标区域。</p>
                {extra("如：图案沿衣褶自然变化，不改变原衣服和人物。")}
            </>;
            break;
        case "fabric-change":
            fields = <>
                {countChoice("fabricCount", "面料参考图数量", [1, 2, 3])}
                {textField("fabricAssignment", "面料与衣片对应关系", "如：面料1用于大身，面料2用于领口袖口", form.fabricCount > 1)}
                {textureFields}
                {extra("如：保留所有纽扣与拉链，只调整面料纹理。")}
            </>;
            break;
        case "remove-decoration":
            fields = <>
                {choice("removeMode", "去装饰后的底色", [{ value: "original", label: "保留原色" }, { value: "white", label: "变为白色" }])}
                <p className="cs-help">用周围同类面料补齐印绣花位置；涂选后只将选区内结果合回原图。</p>
                {extra("如：仅去除胸前印花，保留所有缝线和口袋。")}
            </>;
            break;
        case "sketch-to-style":
            fields = <>
                <Choices id={id("useFabricReference")} label="面料来源" value={form.useFabricReference ? "reference" : "description"} options={[{ value: "description", label: "文字描述" }, { value: "reference", label: "面料参考图" }]} disabled={disabled} onChange={value => update("useFabricReference", value === "reference")} />
                {!form.useFabricReference && textField("fabric", "面料方向", "如：浅蓝色棉麻")}
                {choice("sketchColor", "配色方式", [{ value: "reference", label: "沿用参考色" }, { value: "random", label: "协调新配色" }])}
                {presentationField}
                {extra("如：严格保持线稿的领口、袖口与口袋位置。")}
            </>;
            break;
        case "pattern-create":
            fields = <>
                {choice("patternMode", "创作方式", [{ value: "text", label: "文字创作" }, { value: "reference", label: "参考图创作" }, { value: "variation", label: "相似变体" }])}
                {form.patternMode === "text" ? descriptionField("图案描述", "描述元素、线条、配色、构图与画风。", true) : extra("如：保留枝叶画风，变化花朵与构图。")}
                {form.patternMode === "variation" && numberField("similarity", "参考相似度方向（%）", 10, 100, 10)}
                {choice("patternBackground", "图案背景", [{ value: "white", label: "干净白底" }, { value: "original", label: "按设计保留底色" }])}
                <p className="cs-help">白底结果是普通图片；相似度用于表达设计方向，不是算法测量值。</p>
            </>;
            break;
        case "pattern-fusion":
            fields = <>
                {countChoice("referenceCount", "融合参考图数量", [2, 3])}
                {fusionFields}
                {form.referenceCount === 3 && <p className="cs-help">第三张图只提供配色，不增加新主体或替换前两张图的职责。</p>}
                {choice("patternBackground", "图案背景", [{ value: "white", label: "干净白底" }, { value: "original", label: "按设计保留底色" }])}
                {extra("如：鸟保持完整，花枝围绕主体排列。")}
            </>;
            break;
        case "seamless-pattern":
            fields = <>
                {choice("repeatArrangement", "重复排列", [{ value: "straight", label: "直排" }, { value: "half-drop", label: "半落" }, { value: "half-brick", label: "半砖" }])}
                {choice("boundaryMode", "边界处理", [{ value: "inward", label: "向内修复" }, { value: "outward", label: "向外扩展" }])}
                <div className="cs-field-row">{numberField("ratioX", "左右边界范围（%）", 0, 30)}{numberField("ratioY", "上下边界范围（%）", 0, 30)}</div>
                <p className="cs-help">生成单个花型草案，随后进入花型循环工具检查左右、上下和四角接缝。</p>
                {extra("如：保留中央花朵，只修补跨边叶片。")}
            </>;
            break;
        case "text-to-style":
            fields = <>
                {descriptionField("款式描述", "描述你想设计的服装：关键结构、配色和细节……", true)}
                <div className="cs-field-row">
                    <div className="cs-field">
                        <label className="cs-label" htmlFor={id("category")}>服装品类</label>
                        <select id={id("category")} className="cs-select" value={form.category} onChange={(event) => update("category", event.target.value)} disabled={disabled}>
                            {["按描述判断", "上衣", "针织衫", "外套", "连衣裙", "下装", "其他服装"].map((item) => <option key={item}>{item}</option>)}
                        </select>
                    </div>
                    <div className="cs-field">
                        <label className="cs-label" htmlFor={id("fabric")}>面料方向 <span className="cs-help">可选</span></label>
                        <input id={id("fabric")} className="cs-input" value={form.fabric} onChange={(event) => update("fabric", event.target.value)} maxLength={200} placeholder="如：细针棉针织、轻薄梭织" disabled={disabled} />
                    </div>
                </div>
                {choice("silhouette", "廓形", ["按描述判断", "合体", "微宽松", "宽松", "箱型", "A 字型"])}
                {choice("presentation", "展示方式", ["白底平铺", "模特展示", "设计效果图"])}
            </>;
            break;
        case "style-to-sketch":
            fields = <>
                {choice("sketchStyle", "线条风格", [{ value: "technical", label: "技术感线稿" }, { value: "minimal", label: "极简线稿" }])}
                {choice("sketchDetail", "细节程度", [{ value: "outline", label: "主要轮廓" }, { value: "standard", label: "关键结构" }, { value: "detailed", label: "可见细节" }])}
                <p className="cs-help">保留原图视角与比例，只整理看得见的结构。AI 先输出线稿图片，可在结果卡中继续描摹并导出 SVG。</p>
                {extra("如：保留口袋缝线，省略面料印花。")}
            </>;
            break;
        case "local-restyle":
            fields = <>
                {choice("restyleArea", "改动部位", ["领口", "袖子", "下摆", "口袋", "其他"])}
                <div className="cs-field">
                    <label className="cs-label" htmlFor={id("change")}>要改成什么样<span className="cs-required" aria-hidden="true"> *</span></label>
                    <textarea id={id("change")} className="cs-textarea" value={form.change} onChange={(event) => update("change", event.target.value)} required rows={3} maxLength={3000} disabled={disabled} placeholder={form.restyleArea === "其他" ? "请写清具体部位，以及要调整的结构或细节。" : `如：${form.restyleArea === "领口" ? "圆领改为小 V 领，保留细罗纹领边" : form.restyleArea === "袖子" ? "直筒袖改为轻微喇叭袖，袖长不变" : form.restyleArea === "下摆" ? "下摆改为平直收边，两侧增加小开衩" : "去掉前胸口袋，用原面料自然补齐"}。`} />
                </div>
                <div className="cs-field">
                    <label className="cs-label" htmlFor={id("preserve")}>特别要保留的细节 <span className="cs-help">可选</span></label>
                    <input id={id("preserve")} className="cs-input" value={form.preserve} onChange={(event) => update("preserve", event.target.value)} maxLength={1000} disabled={disabled} placeholder="如：胸前图案、原色与罗纹组织" />
                </div>
                <p className="cs-help">这些文字说明要改什么；上方涂选决定最终合入哪里。未涂选时仅靠 AI 理解修改范围。</p>
                {extra("如：修改部位的纹理和光影要自然衔接。")}
            </>;
            break;
        case "garment-colorway":
        case "pattern-colorway":
            fields = colorFields;
            break;
        case "back-design":
            fields = <>
                {choice("backStructure", "背面结构方向", ["简洁", "育克", "中缝", "自由描述"])}
                {choice("backMotif", "正面图案如何处理", ["不延续", "延续风格"])}
                <p className="cs-help">背面属于新设计推演。「延续风格」会参考正面主题与工艺，不直接复制正面布局。</p>
                {form.backStructure === "自由描述" ? descriptionField("背面结构要求", "写下希望添加或调整的背面结构。", true) : extra("如：在后肩增加横向分割线，避免多余装饰。")}
            </>;
            break;
        case "pattern-extract":
            fields = <>
                {choice("extractMode", "提取范围", ["单独图案", "完整可见花型"])}
                {choice("extractBackground", "背景处理", ["白底", "保留底色"])}
                {choice("extractCraft", "工艺质感", [{ value: "preserve", label: "保留工艺" }, { value: "remove", label: "还原平面图案" }])}
                <p className="cs-help">「完整可见花型」保留画面内的排列关系，不会自动变成无缝循环图。</p>
                {extra("如：只提取中央花朵和叶片，不包含服装边缘。")}
            </>;
            break;
        case "pattern-craft":
            fields = <>
                {choice("craftSource", "工艺依据", [{ value: "description", label: "文字工艺" }, { value: "reference", label: "工艺参考图" }])}
                {choice("craft", "目标工艺", ["刺绣", "毛巾绣", "提花", "胶印"])}
                <div className="cs-field">
                    <label className="cs-label" htmlFor={id("craftFabric")}>承载面料</label>
                    <select id={id("craftFabric")} className="cs-select" value={form.craftFabric} onChange={(event) => update("craftFabric", event.target.value)} disabled={disabled}>
                        {["棉布", "针织面料", "牛仔布", "毛呢", "帆布", "参考图原面料"].map((item) => <option key={item}>{item}</option>)}
                    </select>
                </div>
                <p className="cs-help">保留图案形状与配色，模拟工艺在所选面料上的纹理、厚度与边缘收口。</p>
                {extra("如：强调细密针迹，图案边缘收口干净。")}
            </>;
            break;
        case "accessory-design":
            fields = <>
                {choice("accessoryType", "辅料类型", ["钮扣", "拉链头", "织标", "其他"])}
                {choice("accessoryApply", "图案应用方式", ["形状与纹样", "仅表面纹样"])}
                <p className="cs-help">图片1决定辅料主体，图片2提供图案。「仅表面纹样」保留辅料外形与连接结构。</p>
                {extra("如：图案居中，保留金属质感，不改变连接孔位。")}
            </>;
            break;
        default:
            return null;
    }
    return <div className={`cs-fields cs-fields-${sceneId}`}>{fields}
        {colorLibraryEnabled && colorSlot !== null && sceneId === "garment-colorway" && form.colorMode === "specific" && !disabled && form.colors[colorSlot] !== undefined && <Suspense fallback={<p className="cs-help" role="status">正在打开标准色库…</p>}>
            <StandardColorDialog key={colorSlot} initialHex={form.colors[colorSlot]!} selection={getSceneColorSelection(form, colorSlot)} source={sourceImage} slotLabel={`颜色 ${colorSlot + 1}`} onClose={() => setColorSlot(null)} onSelect={selection => { onChange(setSceneColor(form, colorSlot, selection.hex, selection)); setColorSlot(null); }} />
        </Suspense>}
    </div>;
}

export function SceneUploads({ slots, images, onImage, disabled = false }: {
    slots: SceneSlot[];
    images: Partial<Record<SceneSlotId, ReferenceImage>>;
    onImage: (slotId: SceneSlotId, file: File | null) => void;
    disabled?: boolean;
}) {
    if (!slots.length) return null;
    return <div className={`cs-upload-grid${slots.length === 2 ? " cs-upload-grid-pair" : ""}`}>
        {slots.map((slot) => {
            const reference = images[slot.id];
            return <section className="cs-upload" key={slot.id} aria-labelledby={`cs-upload-${slot.id}-label`}>
                <div className="cs-label" id={`cs-upload-${slot.id}-label`}>{slot.label}{slot.required && <span className="cs-required" aria-hidden="true"> *</span>}</div>
                <label className={`cs-upload-control${reference ? " has-image" : ""}${disabled ? " is-disabled" : ""}`} htmlFor={`cs-upload-${slot.id}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
                    event.preventDefault();
                    if (!disabled && event.dataTransfer.files[0]) onImage(slot.id, event.dataTransfer.files[0]);
                }}>
                    <input id={`cs-upload-${slot.id}`} className="cs-upload-input" type="file" accept="image/jpeg,image/png,image/webp" aria-label={`上传${slot.label}`} disabled={disabled} onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        if (file) onImage(slot.id, file);
                        event.currentTarget.value = "";
                    }} />
                    {reference ? <>
                        <img className="cs-upload-preview" src={reference.dataUrl || reference.url} alt={reference.name || slot.label} />
                        <span className="cs-upload-replace"><Upload size={14} aria-hidden="true" />重新上传</span>
                    </> : <span className="cs-upload-empty"><ImagePlus size={28} strokeWidth={1.5} aria-hidden="true" /><strong>上传{slot.label}</strong><span>点击或拖入 PNG / JPG / WebP</span></span>}
                </label>
                <p className="cs-upload-meta">{slot.hint}</p>
                {reference && <div className="cs-upload-file"><span title={reference.name}>{reference.name}</span><button type="button" className="cs-upload-remove" aria-label={`移除${slot.label}`} disabled={disabled} onClick={() => onImage(slot.id, null)}><Trash2 size={13} aria-hidden="true" />移除</button></div>}
            </section>;
        })}
    </div>;
}
