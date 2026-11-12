import { uiText, useUiText } from "@/lib/i18n";
import { Select, Tooltip } from "antd";
import { FolderOpen, ImagePlus, Palette, Plus, Trash2, Upload } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { useImageDrop } from "@/hooks/use-image-drop";
import { useWorkbenchTask } from "@/components/workbench-tasks";
import type { ReferenceImage } from "@/types/image";
import { useModuleEnabled } from "@/stores/use-module-store";
import { useUserStore } from "@/stores/use-user-store";
import { addSceneColor, getSceneColorSelection, isSceneHexColor, removeSceneColor, setSceneColor, supportsSceneKeepDetails, supportsSceneProductTarget, type SceneForm, type SceneSlot, type SceneSlotId } from "./scene-form-model";

const StandardColorDialog = lazy(() => import("./standard-color-dialog"));

type SceneFieldsProps = {
    sceneId: string;
    form: SceneForm;
    onChange: (next: SceneForm) => void;
    disabled?: boolean;
    sourceImage?: string;
    hasSecondaryImage?: boolean;
    productPicker?: ReactNode;
};

function Choices({ id, label, value, options, onChange, disabled }: {
    id: string;
    label: string;
    value: string;
    options: readonly (string | { value: string; label: string })[];
    onChange: (value: string) => void;
    disabled?: boolean;
}) {
    useUiText();
    return <fieldset className="cs-field" disabled={disabled}>
        <legend className="cs-label">{uiText(label || "")}</legend>
        <div className="cs-choice-group">
            {options.map((option) => {
                const item = typeof option === "string" ? { value: option, label: option } : option;
                return <label key={item.value} className={`cs-choice${value === item.value ? " is-active" : ""}`}>
                    <input className="cs-choice-input" type="radio" name={id} value={item.value} checked={value === item.value} disabled={disabled} onChange={() => onChange(item.value)} />
                    <span>{uiText(item.label || "")}</span>
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

export function SceneFields({ sceneId, form, onChange, disabled = false, sourceImage, hasSecondaryImage = false, productPicker }: SceneFieldsProps) {
    useUiText();
    const instanceId = useId();
    const [colorSlot, setColorSlot] = useState<number | null>(null);
    const colorLibraryEnabled = useModuleEnabled("standard-colors");
    const id = (name: string) => `cs-${sceneId}-${name}-${instanceId}`;
    const update = <K extends keyof SceneForm>(key: K, value: SceneForm[K]) => onChange({ ...form, [key]: value });
    const choice = (key: keyof SceneForm, label: string, options: readonly (string | { value: string; label: string })[]) => <Choices
        id={id(key)} label={uiText(label || "")} value={String(form[key])} options={options} disabled={disabled}
        onChange={(value) => update(key, value as SceneForm[typeof key])}
    />;
    const descriptionField = (label: string, placeholder: string, required = false) => <div className="cs-field">
        <label className="cs-label" htmlFor={id("description")}>{uiText(label || "")}{required && <span className="cs-required" aria-hidden="true"> *</span>}</label>
        <textarea id={id("description")} className="cs-textarea" value={form.description} onChange={(event) => update("description", event.target.value)} rows={required ? 4 : 2} maxLength={4000} placeholder={uiText(placeholder)} required={required} disabled={disabled} />
    </div>;
    const extra = (placeholder: string) => <details className="cs-details">
        <summary>{uiText("补充说明（可选）")}{form.description.trim() ? <span className="cs-details-status">{uiText("已填写")}</span> : null}</summary>
        {descriptionField("具体要求", placeholder)}
    </details>;
    const colorFields = <>
        {choice("colorMode", "配色方式", [{ value: "smart", label: "智能配色" }, { value: "specific", label: "指定颜色" }, { value: "reference", label: "参考图配色" }])}
        {form.colorMode === "smart" && <>
            {choice("colorMood", "配色方向", ["自然柔和", "清爽明亮", "沉稳经典", "强烈对比"])}
            <p className="cs-help">{uiText("根据原图的色块关系生成一套新配色。")}</p>
        </>}
        {form.colorMode === "specific" && <div className="cs-field">
            <div className="cs-label" id={id("palette-label")}>{uiText("目标色板 ")}<span className="cs-help">{form.colors.length} {uiText(" / 6 色")}</span></div>
            <div className="cs-palette" role="group" aria-labelledby={id("palette-label")}>
                {form.colors.map((color, index) => {
                    const selected = getSceneColorSelection(form, index);
                    return <div className="cs-color-entry" key={index}>
                        <div className="cs-color-row">
                            <input type="color" className="cs-color-picker" aria-label={uiText("选择颜色 {value1}", { value1: index + 1 })} value={colorPickerValue(color)} disabled={disabled} onChange={(event) => onChange(setSceneColor(form, index, event.target.value.toUpperCase()))} />
                            <input id={id(`color-${index}`)} className="cs-input cs-color-input" aria-label={uiText("颜色 {value1} HEX 色值", { value1: index + 1 })} aria-invalid={!isSceneHexColor(color)} type="text" value={color} spellCheck={false} autoComplete="off" maxLength={7} disabled={disabled} placeholder="#RRGGBB" onChange={(event) => onChange(setSceneColor(form, index, event.target.value))} />
                            {colorLibraryEnabled && sceneId === "garment-colorway" && <Tooltip title={uiText("从标准色库选择")}><button type="button" className="cs-color-library" aria-label={uiText("从标准色库选择颜色 {value1}", { value1: index + 1 })} disabled={disabled} onClick={() => setColorSlot(index)}><Palette size={14} aria-hidden="true" /><span>{uiText("色库")}</span></button></Tooltip>}
                            <button type="button" className="cs-color-remove" aria-label={uiText("删除颜色 {value1}", { value1: index + 1 })} disabled={disabled} onClick={() => onChange(removeSceneColor(form, index))}><Trash2 size={14} aria-hidden="true" /></button>
                        </div>
                        {selected && <div className="cs-color-source"><Tooltip title={`${selected.library} · ${selected.name}`}><span>{selected.library} · {selected.name}</span></Tooltip><a href={selected.sourceUrl} target="_blank" rel="noreferrer" aria-label={uiText("查看颜色 {value1} 来源", { value1: index + 1 })}>{uiText("来源")}</a></div>}
                    </div>;
                })}
                <button type="button" className="cs-add-color" disabled={disabled || form.colors.length >= 6} onClick={() => onChange(addSceneColor(form))}><Plus size={14} aria-hidden="true" />{uiText("添加颜色")}</button>
            </div>
            <p className="cs-help">{uiText("点击色块选色，或填写 #RGB / #RRGGBB。生成颜色为近似效果。")}</p>
        </div>}
        {form.colorMode === "reference" && <p className="cs-help">{uiText("请在「配色参考图」上传第二张图片，仅参考其中的色彩搭配。")}</p>}
        <div className="cs-field">
            <label className="cs-label" htmlFor={id("colorRegion")}>{uiText("改色区域 ")}<span className="cs-help">{uiText("可选")}</span></label>
            <input id={id("colorRegion")} className="cs-input" value={form.colorRegion} onChange={(event) => update("colorRegion", event.target.value)} maxLength={500} disabled={disabled} placeholder={sceneId === "garment-colorway" ? uiText("如：仅大身，保留袖口与领口颜色") : uiText("如：仅花瓣与叶片，保留底色")} />
            <p className="cs-help">{uiText("需要严格限定局部改色时，请使用支持圈选或蒙版的编辑入口；这里只填写部位名称，不能保证其他区域不变。")}</p>
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
                        <label className="cs-label" htmlFor={id("category")}>{uiText("服装品类")}</label>
                        <Select id={id("category")} value={form.category} onChange={value => update("category", value)} disabled={disabled} options={["按描述判断", "上衣", "针织衫", "外套", "连衣裙", "下装", "其他服装"].map(value => ({ value, label: uiText(value) }))} />
                    </div>
                    <div className="cs-field">
                        <label className="cs-label" htmlFor={id("fabric")}>{uiText("面料方向 ")}<span className="cs-help">{uiText("可选")}</span></label>
                        <input id={id("fabric")} className="cs-input" value={form.fabric} onChange={(event) => update("fabric", event.target.value)} maxLength={200} placeholder={uiText("如：细针棉针织、轻薄梭织")} disabled={disabled} />
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
                <p className="cs-help">{uiText("保留原图视角与比例，只整理看得见的结构。AI 先输出线稿图片，可在结果卡中继续描摹并导出 SVG。")}</p>
                {extra("如：保留口袋缝线，省略面料印花。")}
            </>;
            break;
        case "local-restyle":
            fields = <>
                {choice("restyleArea", "改动部位", ["领口", "袖子", "下摆", "口袋", "其他"])}
                <div className="cs-field">
                    <label className="cs-label" htmlFor={id("change")}>{uiText("要改成什么样")}<span className="cs-required" aria-hidden="true"> *</span></label>
                    <textarea id={id("change")} className="cs-textarea" value={form.change} onChange={(event) => update("change", event.target.value)} required rows={3} maxLength={3000} disabled={disabled} placeholder={form.restyleArea === "其他" ? uiText("请写清具体部位，以及要调整的结构或细节。") : uiText("如：{value1}。", { value1: uiText(form.restyleArea === "领口" ? "圆领改为小 V 领，保留细罗纹领边" : form.restyleArea === "袖子" ? "直筒袖改为轻微喇叭袖，袖长不变" : form.restyleArea === "下摆" ? "下摆改为平直收边，两侧增加小开衩" : "去掉前胸口袋，用原面料自然补齐") })} />
                </div>
                <div className="cs-field">
                    <label className="cs-label" htmlFor={id("preserve")}>{uiText("特别要保留的细节 ")}<span className="cs-help">{uiText("可选")}</span></label>
                    <input id={id("preserve")} className="cs-input" value={form.preserve} onChange={(event) => update("preserve", event.target.value)} maxLength={1000} disabled={disabled} placeholder={uiText("如：胸前图案、原色与罗纹组织")} />
                </div>
                <p className="cs-help">{uiText("这些文字说明要改什么；上方涂选决定最终合入哪里。未涂选时仅靠 AI 理解修改范围。")}</p>
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
                <p className="cs-help">{uiText("背面属于新设计推演。「延续风格」会参考正面主题与工艺，不直接复制正面布局。")}</p>
                {form.backStructure === "自由描述" ? descriptionField("背面结构要求", "写下希望添加或调整的背面结构。", true) : extra("如：在后肩增加横向分割线，避免多余装饰。")}
            </>;
            break;
        case "pattern-extract":
            fields = <>
                {choice("extractMode", "提取范围", ["单独图案", "完整可见花型"])}
                {choice("extractBackground", "背景处理", ["白底", "保留底色"])}
                <p className="cs-help">{uiText("「完整可见花型」保留画面内的排列关系，不会自动变成无缝循环图。")}</p>
                {extra("如：只提取中央花朵和叶片，不包含服装边缘。")}
            </>;
            break;
        case "pattern-craft":
            fields = <>
                {choice("craft", "目标工艺", ["刺绣", "毛巾绣", "提花", "胶印"])}
                <div className="cs-field">
                    <label className="cs-label" htmlFor={id("craftFabric")}>{uiText("承载面料")}</label>
                    <Select id={id("craftFabric")} value={form.craftFabric} onChange={value => update("craftFabric", value)} disabled={disabled} options={["棉布", "针织面料", "牛仔布", "毛呢", "帆布", "参考图原面料"].map(value => ({ value, label: uiText(value) }))} />
                </div>
                <p className="cs-help">{uiText("保留图案形状与配色，模拟工艺在所选面料上的纹理、厚度与边缘收口。")}</p>
                {extra("如：强调细密针迹，图案边缘收口干净。")}
            </>;
            break;
        case "accessory-design":
            fields = <>
                {choice("accessoryType", "辅料类型", ["钮扣", "拉链头", "织标", "其他"])}
                {choice("accessoryApply", "图案应用方式", ["形状与纹样", "仅表面纹样"])}
                <p className="cs-help">{uiText("图片1决定辅料主体，图片2提供图案。「仅表面纹样」保留辅料外形与连接结构。")}</p>
                {extra("如：图案居中，保留金属质感，不改变连接孔位。")}
            </>;
            break;
        case "virtual-try-on":
            fields = <>
                {descriptionField("成人模特与试穿要求", "无模特图时请描述成人模特，如：短发成年女性、全身站姿、简洁黑裤、白色影棚。", !hasSecondaryImage)}
                <p className="cs-help">{uiText("产品图决定衣物设计；可选模特图只提供成人模特与姿态，两张图不会交换角色。未上传模特图时依据文字生成成人模特。")}</p>
                <p className="cs-help">{uiText("本次支持一件产品，不是多服装组合；结果仅为视觉试穿，不保证真实身份、尺寸或合身度。")}</p>
            </>;
            break;
        case "sketch-to-photo":
            fields = <>
                <div className="cs-field">
                    <label className="cs-label" htmlFor={id("fabric")}>{uiText("材质方向")}<span className="cs-required" aria-hidden="true"> *</span></label>
                    <input id={id("fabric")} className="cs-input" value={form.fabric} onChange={event => update("fabric", event.target.value)} maxLength={500} required disabled={disabled} placeholder={uiText("如：羊毛绞花针织，或明确填写参考图材质")} />
                </div>
                <div className="cs-field">
                    <label className="cs-label" htmlFor={id("colorDescription")}>{uiText("颜色方向")}<span className="cs-required" aria-hidden="true"> *</span></label>
                    <input id={id("colorDescription")} className="cs-input" value={form.colorDescription} onChange={event => update("colorDescription", event.target.value)} maxLength={500} required disabled={disabled} placeholder={uiText("如：淡粉色，或明确填写参考图配色")} />
                </div>
                {choice("presentation", "实拍展示方式", ["白底平铺", "白底悬浮"])}
                <p className="cs-help">{uiText("线稿图决定轮廓、结构和细节位置；可选参考图只提供材质与配色。黑白线稿没有原色信息，不能自动还原未知原色。")}</p>
                {extra("如：柔和影棚光线，保留全部绞花数量与罗纹范围。")}
            </>;
            break;
        default:
            return null;
    }
    return <div className={`cs-fields cs-fields-${sceneId}`}>
        {supportsSceneProductTarget(sceneId) && <>
            <div className="cs-field">
                <label className="cs-label" htmlFor={id("targetProduct")}>{uiText("要处理的产品")} <span className="cs-help">{uiText("可手动填写")}</span></label>
                <input id={id("targetProduct")} className="cs-input" value={form.targetProduct} onChange={event => update("targetProduct", event.target.value)} maxLength={500} disabled={disabled} placeholder={uiText("如：左侧蓝色衬衫，不处理裤子与包")} />
                <p className="cs-help">{uiText("用名称和位置说明目标；这不是像素选区，也不会自动生成蒙版。")}</p>
                {productPicker}
            </div>
        </>}
        {supportsSceneKeepDetails(sceneId) && <>
            <div className="cs-field">
                <label className="cs-label" htmlFor={id("keepDetails")}>{uiText("关键特征保持")} <span className="cs-help">{uiText("可选")}</span></label>
                <textarea id={id("keepDetails")} className="cs-textarea" value={form.keepDetails} onChange={event => update("keepDetails", event.target.value)} rows={2} maxLength={2000} disabled={disabled} placeholder={uiText("如：保持领型、纽扣数量、图案位置与面料纹理")} />
                <p className="cs-help">{uiText("作为生成约束保存，结果仍需逐项核对；不能保证像素级一致。")}</p>
            </div>
        </>}
        {!!form.carryoverRequirements?.length && <div className="cs-field">
            <label className="cs-label" htmlFor={id("carryoverRequirements")}>{uiText("沿用设计要求")}</label>
            <textarea id={id("carryoverRequirements")} className="cs-textarea" value={form.carryoverRequirements.join("\n")} onChange={event => update("carryoverRequirements", event.target.value.split("\n"))} rows={4} maxLength={6000} disabled={disabled} />
            <p className="cs-help">{uiText("来自上一步的设计要求；每行一项，可编辑或清空，不会自动提交。")}</p>
        </div>}
        {fields}
        {colorLibraryEnabled && colorSlot !== null && sceneId === "garment-colorway" && form.colorMode === "specific" && !disabled && form.colors[colorSlot] !== undefined && <Suspense fallback={<p className="cs-help" role="status">{uiText("正在打开标准色库…")}</p>}>
            <StandardColorDialog key={colorSlot} initialHex={form.colors[colorSlot]!} selection={getSceneColorSelection(form, colorSlot)} source={sourceImage} slotLabel={uiText("颜色 {value1}", { value1: colorSlot + 1 })} onClose={() => setColorSlot(null)} onSelect={selection => { onChange(setSceneColor(form, colorSlot, selection.hex, selection)); setColorSlot(null); }} />
        </Suspense>}
    </div>;
}

export function SceneUploads({ slots, images, onImage, onAsset, disabled = false, scopeKey = "creative" }: {
    slots: SceneSlot[];
    images: Partial<Record<SceneSlotId, ReferenceImage>>;
    onImage: (slotId: SceneSlotId, file: File | null) => void | Promise<void>;
    onAsset?: (slotId: SceneSlotId, asset: Extract<InsertAssetPayload, { kind: "image" }>) => Promise<void>;
    disabled?: boolean;
    scopeKey?: string;
}) {
    useUiText();
    if (!slots.length) return null;
    return <div className={`cs-upload-grid${slots.length === 2 ? " cs-upload-grid-pair" : ""}`}>
        {slots.map(slot => <SceneUploadSlot key={slot.id} slot={slot} reference={images[slot.id]} onImage={onImage} onAsset={onAsset} disabled={disabled} scopeKey={scopeKey} />)}
    </div>;
}

function SceneUploadSlot({ slot, reference, onImage, onAsset, disabled, scopeKey }: {
    slot: SceneSlot;
    reference?: ReferenceImage;
    onImage: (slotId: SceneSlotId, file: File | null) => void | Promise<void>;
    onAsset?: (slotId: SceneSlotId, asset: Extract<InsertAssetPayload, { kind: "image" }>) => Promise<void>;
    disabled: boolean;
    scopeKey: string;
}) {
    useUiText();
    const task = useWorkbenchTask();
    const ownerId = useUserStore(state => state.user?.id);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const selectionScope = `${scopeKey}:${task.id}:${slot.id}:${slot.label}:${ownerId}`;
    const latest = useRef({ selectionScope, disabled, active: task.active });
    latest.current = { selectionScope, disabled, active: task.active };
    useEffect(() => { setAssetPickerOpen(false); }, [selectionScope, task.active]);
    const uploadId = `cs-upload-${slot.id}-${useId()}`;
    const imageDrop = useImageDrop({
        scopeKey: `${scopeKey}:${task.id}:${slot.id}:${slot.label}`,
        disabled: disabled || !task.active,
        onFiles: async files => {
            if (files.length !== 1) throw new Error("每个参考图位置一次只能拖入一张图片，请分别放入对应位置。");
            await onImage(slot.id, files[0]!);
        },
    });
    return <section className="cs-upload" aria-labelledby={`${uploadId}-label`}>
                <div className="cs-label" id={`${uploadId}-label`}>{uiText(slot.label || "")}{slot.required ? <span className="cs-required" aria-hidden="true"> *</span> : <span className="cs-help"> · {uiText("可选")}</span>}</div>
                <label {...imageDrop.dropProps} aria-busy={imageDrop.reading} className={`cs-upload-control${reference ? " has-image" : ""}${disabled ? " is-disabled" : ""}${imageDrop.dragging ? " outline outline-2 outline-offset-2 outline-primary" : ""}`} htmlFor={uploadId}>
                    <input id={uploadId} className="cs-upload-input" type="file" accept="image/jpeg,image/png,image/webp" aria-label={uiText("上传{label}", { label: uiText(slot.label) })} disabled={disabled} onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        if (file) onImage(slot.id, file);
                        event.currentTarget.value = "";
                    }} />
                    {reference ? <>
                        <img className="cs-upload-preview" src={reference.dataUrl || reference.url} alt={reference.name || uiText(slot.label)} />
                        <span className="cs-upload-replace"><Upload size={14} aria-hidden="true" />{uiText("重新上传")}</span>
                    </> : <span className="cs-upload-empty"><ImagePlus size={28} strokeWidth={1.5} aria-hidden="true" /><strong>{uiText("上传")}{uiText(slot.label || "")}</strong><span>{uiText("点击或拖入 PNG / JPG / WebP")}</span></span>}
                </label>
                {onAsset && <button type="button" className="cs-tool-entry" aria-label={uiText("从素材库选择{label}", { label: uiText(slot.label) })} disabled={disabled || !task.active} onClick={() => setAssetPickerOpen(true)}><FolderOpen size={14} aria-hidden="true" />{uiText("从素材库选择")}</button>}
                {assetPickerOpen && onAsset && task.active && <AssetPickerModal open selectionMode="single-image" onClose={() => setAssetPickerOpen(false)} onInsert={async asset => {
                    if (asset.kind !== "image") throw new Error("请选择图片素材");
                    if (latest.current.selectionScope !== selectionScope || latest.current.disabled || !latest.current.active || useUserStore.getState().user?.id !== ownerId) throw new Error("参考图位置或任务状态已变化，请重新打开素材库");
                    await onAsset(slot.id, asset);
                    if (latest.current.selectionScope === selectionScope) setAssetPickerOpen(false);
                }} />}
                {imageDrop.dragging || imageDrop.reading ? <p role="status" className="cs-help">{imageDrop.dragging ? uiText("松开以添加到{label}，不会自动生成。", { label: uiText(slot.label) }) : uiText("正在读取拖入图片，请稍候。")}</p> : null}
                <p className="cs-upload-meta">{uiText(slot.hint || "")}</p>
                {reference && <div className="cs-upload-file"><Tooltip title={reference.name}><span>{reference.name}</span></Tooltip><button type="button" className="cs-upload-remove" aria-label={uiText("移除{label}", { label: uiText(slot.label) })} disabled={disabled} onClick={() => onImage(slot.id, null)}><Trash2 size={13} aria-hidden="true" />{uiText("移除")}</button></div>}
            </section>;
}
