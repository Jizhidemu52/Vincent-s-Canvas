import type { CanvasNodeData } from "@/types/canvas";

type Box=Pick<CanvasNodeData,"position"|"width"|"height">;
type Size=Pick<Box,"width"|"height">;
const gap=36;
function nextSlot(anchor:Box,occupied:readonly Box[],size:Size,horizontal:boolean) {
    const cross=horizontal ? anchor.position.y : anchor.position.x+(anchor.width-size.width)/2;
    let start=horizontal ? anchor.position.x+anchor.width+gap : anchor.position.y+anchor.height+gap;
    const end=(n:Box)=>horizontal ? n.position.x+n.width : n.position.y+n.height;
    const blocks=occupied.filter(n=>horizontal ? cross<n.position.y+n.height+gap && cross+size.height+gap>n.position.y : cross<n.position.x+n.width+gap && cross+size.width+gap>n.position.x)
        .sort((a,b)=>horizontal?a.position.x-b.position.x:a.position.y-b.position.y);
    for(const n of blocks){
        if(start+(horizontal?size.width:size.height)+gap <= (horizontal?n.position.x:n.position.y)) break;
        start=Math.max(start,end(n)+gap);
    }
    return horizontal?{x:start,y:cross}:{x:cross,y:start};
}
export const variantSlot=(root:Box,nodes:readonly Box[],size:Size=root)=>nextSlot(root,nodes,size,true);
export const wearSlot=(source:Box,nodes:readonly Box[],size:Size=source)=>nextSlot(source,nodes,size,false);
