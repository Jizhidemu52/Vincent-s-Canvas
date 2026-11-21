export type WearPosition = "head"|"neck"|"upper"|"lower"|"full"|"hand"|"foot"|"shoulder"|"none";
export type ProductAudience = "women"|"men"|"kids"|"unisex"|"unknown";
export type ProductCardItem = {
    category:string; audience:ProductAudience; material:string; parts:string[];
    colors:Array<{name:string;hex?:string;part?:string;primary?:boolean}>;
    pattern:string; wearPosition:WearPosition; primary:boolean;
};
export type ProductCard = {version:2;view:"flat"|"hanging"|"on-model"|"mannequin"|"sketch"|"fabric"|"other";items:ProductCardItem[];background:string};
export function primaryItem(card:ProductCard) {
    return card.items.find(item=>item.primary) ?? card.items[0] ?? null;
}
export function productNoun(item:Pick<ProductCardItem,"category">|null){return item?.category||"产品";}
