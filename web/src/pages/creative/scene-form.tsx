import { ImagePlus, Plus, Trash2, Upload } from "lucide-react";
import type { ReferenceImage } from "@/types/image";
import { isSceneHexColor, type SceneForm, type SceneSlot, type SceneSlotId } from "./scene-form-model";

type SceneFieldsProps = {
    sceneId: string;
    form: SceneForm;
    onChange: (next: SceneForm) => void;
    disabled?: boolean;
};

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

export function SceneFields({ sceneId, form, onChange, disabled = false }: SceneFieldsProps) {
    const id = (name: string) => `cs-${sceneId}-${name}`;
    const update = <K extends keyof SceneForm>(key: K, value: SceneForm[K]) => onChange({ ...form, [key]: value });
    const choice = (key: keyof SceneForm, label: string, options: readonly (string | { value: string; label: string })[]) => <Choices
        id={id(key)} label={label} value={String(form[key])} options={options} disabled={disabled}
        onChange={(value) => update(key, value as SceneForm[typeof key])}
    />;
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
                {form.colors.map((color, index) => <div className="cs-color-row" key={index}>
                    <input type="color" className="cs-color-picker" aria-label={`选择颜色 ${index + 1}`} value={colorPickerValue(color)} disabled={disabled} onChange={(event) => update("colors", form.colors.map((item, at) => at === index ? event.target.value.toUpperCase() : item))} />
                    <input id={id(`color-${index}`)} className="cs-input cs-color-input" aria-label={`颜色 ${index + 1} HEX 色值`} aria-invalid={!isSceneHexColor(color)} type="text" value={color} spellCheck={false} autoComplete="off" maxLength={7} disabled={disabled} placeholder="#RRGGBB" onChange={(event) => update("colors", form.colors.map((item, at) => at === index ? event.target.value : item))} />
                    <button type="button" className="cs-color-remove" aria-label={`删除颜色 ${index + 1}`} disabled={disabled} onClick={() => update("colors", form.colors.filter((_, at) => at !== index))}><Trash2 size={14} aria-hidden="true" /></button>
                </div>)}
                <button type="button" className="cs-add-color" disabled={disabled || form.colors.length >= 6} onClick={() => update("colors", [...form.colors, "#808080"])}><Plus size={14} aria-hidden="true" />添加颜色</button>
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
                <p className="cs-help">「完整可见花型」保留画面内的排列关系，不会自动变成无缝循环图。</p>
                {extra("如：只提取中央花朵和叶片，不包含服装边缘。")}
            </>;
            break;
        case "pattern-craft":
            fields = <>
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
    return <div className={`cs-fields cs-fields-${sceneId}`}>{fields}</div>;
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
