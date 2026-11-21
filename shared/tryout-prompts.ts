import {productNoun,type ProductCardItem,type WearPosition} from "./product-card";
import type { TryoutColor } from "./tryout";
import {recipeFor} from "./try-on-recipes";

const positions:Record<WearPosition,string>={head:"头部",neck:"颈部",upper:"上身",lower:"下身",full:"全身",hand:"手部",foot:"脚部",shoulder:"肩背",none:""};
type Item=Pick<ProductCardItem,"category"|"wearPosition">;
export function wearVerb(position:WearPosition) {
    if(position==="shoulder") return "背上";
    if(position==="head"||position==="neck"||position==="hand") return "戴上";
    return "穿上";
}
function subject(item:Item|null,part?:string|null) {
    return "图片1中"+productNoun(item)+(part ? "的"+part : "");
}
export function colorPrompt(item:Item|null,part:string|null,color:TryoutColor,fallbackHex?:string) {
    const area=subject(item,part)+(part ? "" : fallbackHex ? "上颜色接近 "+fallbackHex+" 的部分" : "的主体颜色");
    return "把"+area+"改为"+color.name+"（色值 "+color.hex+(color.code?"，色号 "+color.code:"")+"）。其余部位的颜色、款式结构、材质纹理、图案位置和背景保持不变。";
}
export type TryoutMaterial = {type:"preset";name:string;description:string} | {type:"uploaded";name:string;useColor:boolean};
export function materialPrompt(item:Item|null,part:string|null,material:TryoutMaterial,fallbackHex?:string) {
    const area=subject(item,part)+(!part&&fallbackHex?"上颜色接近 "+fallbackHex+" 的部分":"");
    if(material.type==="preset") return "把"+area+"换成"+material.name+"："+material.description+"。保持款式版型、结构、比例、颜色和图案位置不变，只改变材质的纹理、厚度和垂感。背景保持不变。";
    return "图片2是材质参考。把图片2的材质迁移到"+area+"上。保持图片1的款式版型、结构、比例和图案位置不变。"+(material.useColor?"同时采用图片2的颜色。":"只取图片2的纹理和质感，不取它的颜色。")+"背景保持不变。";
}
export function wearPrompt(products:readonly (Item|null)[]) {
    if(!products.length) throw new Error("请选择上身产品");
    const lines=products.map((p,i)=>{
        const ref="图片"+(i+2);
        if(!p?.category||p.wearPosition==="none")return "让图片1的模特穿戴"+ref+"中的产品，按这件产品本来的穿戴方式。";
        const recipe=recipeFor(p),verb=p.wearPosition==="hand"&&recipe.group==="包"?"提起":wearVerb(p.wearPosition);
        return "让图片1的模特"+verb+ref+"的"+p.category+"，位置在"+positions[p.wearPosition]+"。"+(recipe.guard?"只按"+ref+"中实际存在的细节处理，不新增部件。"+recipe.guard:"");
    });
    return ["图片1是模特，决定人物的外貌、姿势和背景。",...lines,products.length>1?"每件产品保持各自的款式、颜色、图案和材质，不互相混合。":"产品的款式、颜色、图案和材质与图片2完全一致。","模特的脸、体型、姿势和背景保持不变。"].join("\n");
}
export function tryoutImageOptions(kind:"color"|"material"|"wear",tier:"quick"|"hd") {
    return {complexity:kind==="wear"&&tier==="hd"?"medium":"low", quality:tier==="quick"?"low":"high",resolution:tier==="quick"?"1k":"2k"} as const;
}
