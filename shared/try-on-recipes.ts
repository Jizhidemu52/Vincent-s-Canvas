import type {ProductCardItem,WearPosition} from "./product-card";

export type Framing="head"|"half"|"full";
type Item=Pick<ProductCardItem,"category"|"wearPosition">;
type Definition={group:string;positions:readonly WearPosition[];words:readonly string[];guard:string};
export const groups:readonly Definition[]=[
    {group:"帽子",positions:["head"],words:["帽","贝雷","beanie","cap","hat"],guard:"保留可见的帽型、帽檐方向、翻边宽度及图案位置，佩戴深度自然。"},
    {group:"围脖与围巾",positions:["neck"],words:["围脖","围巾","围领","丝巾","披肩","scarf","snood"],guard:"保留参考图的长度比例、边缘、流苏和纹样；围绕颈部自然垂落。"},
    {group:"手套",positions:["hand"],words:["手套","glove","mitten"],guard:"保持可见的分指或连指结构、袖口长度和装饰数量；贴合手掌，不额外生成手指。"},
    {group:"袜子",positions:["foot","lower"],words:["袜","sock"],guard:"保持袜筒高度、袜口与脚跟的配色和纹样，不改变左右方向。"},
    {group:"包",positions:["shoulder","hand","lower"],words:["包","bag","tote","pouch"],guard:"保持包型、包口、肩带或提手的连接点、比例和五金数量。"},
    {group:"腰带与小配件",positions:["head","lower","full"],words:["腰带","皮带","发带","发夹","发箍","头箍","belt","headband","hair clip"],guard:"保持带宽、扣件或夹口方向及可见装饰，按参考图结构固定在身体上。"},
    {group:"首饰",positions:["head","neck","hand"],words:["耳饰","耳环","耳钉","项链","吊坠","手链","戒指","necklace","earring","bracelet","ring"],guard:"保留可见的链节、吊坠、宝石或金属细节与数量，不添加其他首饰。"},
    {group:"鞋",positions:["foot"],words:["鞋","靴","shoe","boot","sneaker"],guard:"保持鞋头、鞋底轮廓与厚度、鞋面分割线和系带方式，左右脚方向正确。"},
    {group:"大件对照",positions:["upper","lower","full"],words:["毛衫","毛衣","半裙","外套","针织衫","sweater","skirt","coat"],guard:"保持衣片轮廓、衣长、开口、纽扣与纹样位置。"},
];
export const framingFor=(position?:WearPosition):Framing=>position==="head"||position==="neck"?"head":position==="upper"||position==="hand"?"half":"full";
export const DEFAULT_RECIPE={group:"通用",framing:"full" as Framing,inputMode:"original",template:"preserve",complexity:"low",resolution:"1k",twoStep:false,enabled:true,score:null,passRate:null,testedAt:null,classifierVersion:"product-card-v2",guard:""} as const;
export function recipeFor(item:Item|null){
    const term=item?.category.trim().toLowerCase()??"";
    const words=term.split(/[^a-z]+/);
    const found=item&&groups.find(g=>g.positions.includes(item.wearPosition)&&g.words.some(w=>/^[a-z ]+$/.test(w)?(w.includes(" ")?(" "+words.join(" ")+" ").includes(" "+w+" "):words.some(v=>v===w||v===w+"s")):term.includes(w)));
    return {...DEFAULT_RECIPE,group:found?.group??DEFAULT_RECIPE.group,framing:framingFor(item?.wearPosition),guard:found?.guard??""};
}
