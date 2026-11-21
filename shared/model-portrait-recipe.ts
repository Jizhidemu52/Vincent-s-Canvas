import {modelFramings,type ModelFraming,type ModelPreset} from "./model-match";

export type PortraitSlot={identity:ModelPreset["identity"];framing:ModelFraming;expectedAssetId:string|null;fullAssetId:string|null};
export const slotKey=(slot:Pick<PortraitSlot,"identity"|"framing">)=>slot.identity+"/"+slot.framing;
const subject={"white-woman":"成年白人女性时装模特","white-man":"成年白人男性时装模特","white-girl":"约八岁的白人女孩，儿童服装模特","white-boy":"约八岁的白人男孩，儿童服装模特"};
export function portraitPrompt({identity,framing}:PortraitSlot){
    if(framing!=="full")return "图片1是同一位模特。保持这个人的脸、发型、肤色、衣着和背景完全不变，改为"+(framing==="half"?"半身取景，从头顶到腰部":"头肩特写，从头顶到胸口，露出完整的颈部")+"，正面朝向镜头。";
    return "一位"+subject[identity]+"。全身站立，从头到脚完整入镜。正面自然站姿，双臂自然下垂，表情平静。穿白色圆领短袖、深色直筒长裤和白色平底鞋。不戴帽子、围巾、首饰，不背包。头发不遮挡脖子和肩膀。浅灰无缝背景，柔和均匀的影棚光，没有道具。头顶和脚下留白，真实高清摄影。";
}
export function availablePortraitSlots(rows:(Pick<ModelPreset,"identity"|"framing"|"assetId">&{draftAssetId:string|null;status:string})[],identity:PortraitSlot["identity"]){
    const current=(frame:ModelFraming)=>rows.find(r=>r.identity===identity&&r.framing===frame);
    const full=current("full"),reference=full?.draftAssetId??(full?.status==="published"?full.assetId:null);
    return modelFramings.map(framing=>{const slot=current(framing);return {identity,framing,expectedAssetId:slot?.draftAssetId??slot?.assetId??null,fullAssetId:framing==="full"?null:reference};});
}
