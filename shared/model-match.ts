import type {ProductCardItem,ProductAudience} from "./product-card";

export const modelIdentities=[
    {identity:"white-woman",audience:"women",name:"女模特"},{identity:"white-man",audience:"men",name:"男模特"},
    {identity:"white-girl",audience:"girls",name:"女童模特"},{identity:"white-boy",audience:"boys",name:"男童模特"},
] as const;
export const modelFramings=["full","half","head"] as const;
export type ModelFraming=typeof modelFramings[number];
export type ModelAudience=typeof modelIdentities[number]["audience"];
export type ModelPreset={id:string;identity:typeof modelIdentities[number]["identity"];name:string;audience:ModelAudience;framing:ModelFraming;assetId:string};
export type PersonalModel={id:string;name:string;audience:ModelAudience};
export type ModelDefault={presetIdentity?:string;assetId?:string;lastChild?:"girls"|"boys"};
export type ModelSelection={presetId:string}|{assetId:string}|{presetIdentity:typeof modelIdentities[number]["identity"]}|{auto:true};
const child=(a:ModelAudience)=>a==="girls"||a==="boys";
function compatible(a:ModelAudience,p:ProductAudience){
    if(p==="kids")return child(a);
    return !child(a)&&(p==="unisex"||p==="unknown"||p===a);
}
export function pickModel(presets:readonly ModelPreset[],item:Pick<ProductCardItem,"audience"|"wearPosition">|null,pref:ModelDefault={},mine:readonly PersonalModel[]=[]):{assetId:string}|{presetId:string}|null{
    const audience=item?.audience??"unknown";
    const personal=mine.find(m=>m.id===pref.assetId);
    if(item&&personal&&compatible(personal.audience,audience))return {assetId:personal.id};
    const target=item?.wearPosition,frame:ModelFraming=target==="head"||target==="neck"?"head":target==="upper"||target==="hand"?"half":"full";
    const group:ModelAudience=audience==="kids"?pref.lastChild??"girls":audience==="men"?"men":"women";
    const choices=presets.filter(p=>compatible(p.audience,audience));
    const ranked=choices.filter(p=>item&&p.identity===pref.presetIdentity||p.audience===group||audience==="kids").sort((a,b)=>{
        const rank=(p:ModelPreset)=>(item&&p.identity===pref.presetIdentity?0:p.audience===group?10:20)+(p.framing===frame?0:p.framing==="full"?2:4);
        return rank(a)-rank(b)||a.id.localeCompare(b.id);
    });
    return ranked[0]?{presetId:ranked[0].id}:null;
}
