import { nanoid } from "nanoid";
import { canvasImageSource } from "@/lib/canvas/canvas-image-source";
import { placeCanvasImageOutputs } from "@/lib/canvas/canvas-image-output-placement";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { boardStaleItems, defaultLayout, type AnyProposalBoard, type ProposalBoardSpec } from "@/lib/canvas/proposal-board";
import { collectTryoutCells } from "@/lib/tryout/lineage";
import type { TryoutBoardOptions } from "../../../../shared/tryout";
import { exportBoardPng } from "@/lib/canvas/proposal-board-export";
import { suggestPalette } from "@/pages/creative/image-processing";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type Item = ProposalBoardSpec["items"][number];

export async function loadBoardOriginal(item: Item, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const source = await resolveImageUrl(item.storageKey, canvasImageSource(item));
    if (!source) throw new Error("找不到提案板原图");
    const url = new URL(source, location.origin);
    if (!(url.protocol === "data:" && /^data:image\//i.test(source)) && url.origin !== location.origin) throw new Error("请先将外部图片保存到画布");
    const response = await fetch(url, { signal, redirect: "error" });
    if (!response.ok) throw new Error("原图读取失败：" + response.status);
    const image = await createImageBitmap(await response.blob());
    if (signal?.aborted) { image.close(); signal.throwIfAborted(); }
    return image;
}

function colorwaySource(node: CanvasNodeData) {
    const record = node.metadata?.generationRecord;
    const scene = record?.promptInput?.scene || node.metadata?.promptInput?.scene;
    return scene === "garment-colorway" || scene === "pattern-colorway" ? record?.sourceNodeId || node.metadata?.generationOrigin?.sourceNodeId : undefined;
}

export function newBoardSpec(images: CanvasNodeData[], title: string, designer: string, date: string): ProposalBoardSpec {
    const source = colorwaySource(images[0]);
    return {
        version: 1,page:"a4-landscape",layout:defaultLayout(images.length,Boolean(source && images.every(n=>colorwaySource(n)===source))),
        title,fields:{styleNo:"",fabric:"",craft:"",note:""},footer:{designer,date},palette:[],showPalette:true,
        items:images.map(node=>{
            const {storageKey,serverAssetId,content} = node.metadata ?? {};
            return {nodeId:node.id,caption:node.title||"",storageKey,serverAssetId,content:serverAssetId ? canvasImageSource({serverAssetId}) : storageKey ? "" : content};
        }),
    };
}

async function boardPalette(spec:ProposalBoardSpec, signal:AbortSignal) {
    const colors = new Map<string,number>();
    for (const item of spec.items) {
        const image=await loadBoardOriginal(item,signal);
        try {
            const scale=Math.min(1,256/Math.max(image.width,image.height)), canvas=document.createElement("canvas");
            canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
            const ctx=canvas.getContext("2d",{willReadFrequently:true});
            if (!ctx) throw new Error("无法读取图片色卡");
            ctx.drawImage(image,0,0,canvas.width,canvas.height);
            const palette=suggestPalette(ctx.getImageData(0,0,canvas.width,canvas.height),6);
            item.dominantHex=palette[0];
            for(const [index,hex] of palette.entries()) {
                const channels=[1,3,5].map(i=>Number.parseInt(hex.slice(i,i+2),16));
                if (Math.min(...channels)>240 || Math.max(...channels)<16) continue;
                colors.set(hex,(colors.get(hex)??0)+6-index);
            }
        } finally {image.close();}
    }
    return [...colors].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([hex])=>({hex}));
}

export async function createProposalBoard(args:{
    sources:CanvasNodeData[]; title:string; designer:string; signal:AbortSignal;
    currentNodes:()=>CanvasNodeData[]; writable:()=>Promise<boolean>;
    commit:(node:CanvasNodeData)=>void;
    reflow?:Partial<TryoutBoardOptions>;
}) {
    const {sources,signal}=args;
    if (!sources.length) throw new Error("请选择图片");
    const existing=args.reflow && sources.length===1 ? sources[0].metadata?.proposalBoard : undefined;
    if (args.reflow && (existing?.version!==2 || sources[0].metadata?.locked)) throw new Error("请选择可编辑的试款提案板");
    const nodes=args.currentNodes(), ids=sources.map(n=>n.id), cells=collectTryoutCells(ids,nodes);
    if (cells && (!cells.length || cells.length>8)) throw new Error("一页最多排 8 款，请点选要放在这一页的款式");
    const refs=new Set(cells?.flatMap(cell=>[cell.styleNodeId,...cell.wearNodeIds]));
    const base=newBoardSpec(cells ? nodes.filter(n=>refs.has(n.id)) : sources.slice(0,8),args.title,args.designer,new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai"}).format(new Date()));
    const spec:AnyProposalBoard=existing?.version===2 ? {...existing,...args.reflow} : cells ? {...base,version:2,cells,columns:3,orientation:"landscape",showWear:true,showCode:true,showPalette:false} : base;
    const assertCurrent=async()=>{
        if(!await args.writable()) throw new Error("画布已切换或不再可写");
        signal.throwIfAborted();
        const current=new Map(args.currentNodes().map(n=>[n.id,n]));
        if (existing) {
            const target=current.get(sources[0].id);
            if(!target || target.metadata?.locked || target.metadata?.proposalBoard!==existing) throw new Error("提案板已变动，请重新选择");
            return;
        }
        if(spec.items.some(i=>!current.has(i.nodeId))||boardStaleItems(spec,current).length || (cells && JSON.stringify(cells)!==JSON.stringify(collectTryoutCells(ids,[...current.values()])))) throw new Error("款式或原图已变动，请重新选择图片");
    };
    await assertCurrent();
    if(spec.version===1) spec.palette=await boardPalette(spec,signal);
    const blob=await exportBoardPng(spec,loadBoardOriginal,{hd:false,signal});
    await assertCurrent();
    const image=await uploadImage(blob);
    await assertCurrent();
    const size=fitNodeSize(image.width,image.height);
    args.commit({id:existing?sources[0].id:nanoid(),type:CanvasNodeType.Image,title:existing?sources[0].title:spec.title+"_提案板",...size,position:existing?sources[0].position:placeCanvasImageOutputs(args.currentNodes(),sources,size,sources[0].position,96),
        metadata:{content:image.url,storageKey:image.storageKey,naturalWidth:image.width,naturalHeight:image.height,mimeType:image.mimeType,bytes:image.bytes,status:"success",proposalBoard:spec}});
}
