import { expect,test } from "bun:test";
import { collectTryoutCells } from "@/lib/tryout/lineage";
import { CanvasNodeType,type CanvasNodeData } from "@/types/canvas";
import type { TryoutMeta } from "../../shared/tryout";

function node(id:string,tryout?:TryoutMeta):CanvasNodeData {
    return { id,type:CanvasNodeType.Image,title:"同名",position:{x:0,y:0},width:20,height:20,metadata:{serverAssetId:id,tryout} };
}
function result(id:string,root:string,source:string,kind:Exclude<TryoutMeta["kind"],"original">,picked=false,order=0) {
    return node(id,{version:1,rootNodeId:root,sourceNodeId:source,kind,tier:"quick",prompt:"模板",picked,timing:{droppedAt:order}});
}
test("pairs by IDs across moves, duplicate titles, a variant of a variant and multiple model photos",()=>{
    const nodes=[node("A"),node("B"),result("red","A","A","color"),result("w2","A","red","wear",false,2),result("w1","A","red","wear",false,1),result("wool","A","red","material"),result("stray","B","red","wear"),result("b1","B","B","color")];
    const initial=structuredClone(nodes);
    const cells=collectTryoutCells(["A"],nodes)!;
    expect(cells.map(c=>[c.styleNodeId,c.wearNodeIds])).toEqual([["A",[]],["red",["w1","w2"]],["wool",[]]]);
    expect(nodes).toEqual(initial);
    nodes[2].position={x:10000,y:-500};
    nodes[2].metadata!.tryout!.tier="hd";
    expect(collectTryoutCells(["A"],nodes)).toEqual(cells);
    nodes[2].metadata!.tryout!.picked=true;
    expect(collectTryoutCells(["A"],nodes)).toEqual([cells[1]]);
    expect(collectTryoutCells(["w2","wool","red"],nodes)).toEqual(cells.slice(1));
    nodes[3].metadata!.status="loading";
    nodes[4].metadata!.status="error";
    expect(collectTryoutCells(["red"],nodes)![0].wearNodeIds).toEqual([]);
    expect(collectTryoutCells(["none"],nodes)).toBeNull();
});
