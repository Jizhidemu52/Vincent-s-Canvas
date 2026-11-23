import { expect,test } from "bun:test";
import { colorPrompt,materialEdit,wearPrompt,tryoutImageOptions } from "../../shared/tryout-prompts";
import { variantSlot,wearSlot } from "@/lib/tryout/placement";
const hat={category:"毛线帽",wearPosition:"head"} as const;
test("templates are direct, distinguish fabric photos from color swaps, and preserve indexed references",()=>{
    expect(colorPrompt(hat,"翻边",{name:"酒红",hex:"#772233",code:"R9"})).toContain("毛线帽的翻边改为酒红（色值 #772233，色号 R9）");
    expect(colorPrompt(null,null,{name:"蓝",hex:"#315582"},"#123456")).toContain("颜色接近 #123456 的部分");
    const text=materialEdit("product",hat,null,{type:"text",name:"罗纹",description:"细罗纹"});
    expect(text.ids).toEqual(["product"]);expect(text.prompt).not.toContain("图片2");expect(text.prompt).toContain("细罗纹");
    const photo={type:"photo",assetId:"fabric",description:"纵向窄凸棱"} as const;
    const edit=materialEdit("product",hat,"翻边",photo);
    expect(edit.ids).toEqual(["product","fabric"]);expect(edit.prompt).toContain("毛线帽的翻边");expect(edit.prompt).toContain("纵向窄凸棱");expect(edit.prompt).toContain("不取它的颜色");
    expect(materialEdit("product",null,null,{...photo,useColor:true}).prompt).toContain("采用图片2的颜色");
    expect(materialEdit("product",null,null,{type:"photo",assetId:"fabric"}).ids).toEqual(["product","fabric"]);
    expect(wearPrompt([hat,null])).toContain("戴上图片2的毛线帽");
    expect(wearPrompt([hat,null])).toContain("穿戴图片3中的产品");
    for(const kind of ["color","wear","material"] as const) {
        expect(tryoutImageOptions(kind,"quick")).toEqual({complexity:"low",quality:"low",resolution:"1k"});
        expect(tryoutImageOptions(kind,"hd")).toEqual({complexity:kind==="wear"?"medium":"low",quality:"high",resolution:"2k"});
    }
});
test("first horizontal gap stays on the root row, wear is centered and skips blockers of different sizes",()=>{
    const box=(x:number,y:number,width=100,height=80)=>({position:{x,y},width,height});
    const root=box(0,0), occupied=[root,box(136,0),box(600,0,500,200),box(-30,116,155,300),box(900,600)];
    expect(variantSlot(root,occupied)).toEqual({x:272,y:0});
    expect(wearSlot(root,occupied,{width:80,height:120})).toEqual({x:10,y:452});
    expect(wearSlot(occupied[1],occupied)).toEqual({x:136,y:452});
    expect(variantSlot(root,[...occupied].reverse())).toEqual(variantSlot(root,occupied));
});
