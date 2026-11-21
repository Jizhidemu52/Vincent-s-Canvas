import {deltaE2000,hexToLab} from "./color-distance";
import type {ProductCardItem} from "./product-card";

export function closestProductPart(item:ProductCardItem|null,regionHex?:string){
    if(!item||!regionHex)return null;
    const target=hexToLab(regionHex),parts=new Map<string,number>();
    for(const c of item.colors){
        if(!c.hex||!c.part||!item.parts.includes(c.part))continue;
        parts.set(c.part,Math.min(parts.get(c.part)??Infinity,deltaE2000(target,hexToLab(c.hex))));
    }
    const [best,second]=[...parts].sort((a,b)=>a[1]-b[1]);
    return best&&best[1]<=12&&(!second||second[1]-best[1]>=3)?best[0]:null;
}
