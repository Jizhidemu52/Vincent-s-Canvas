import {hasCanvasImageSource} from "@/lib/canvas/canvas-image-source";
import {CanvasNodeType,type CanvasNodeData} from "@/types/canvas";

export function isTryoutProduct(node?:CanvasNodeData){
    return node?.type===CanvasNodeType.Image&&hasCanvasImageSource(node.metadata)&&!node.metadata.locked&&!node.metadata.proposalBoard&&node.metadata.tryout?.kind!=="wear"&&node.metadata.status!=="loading"&&node.metadata.status!=="error";
}
