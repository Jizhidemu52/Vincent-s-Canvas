import {writePsd,type Layer} from "ag-psd";
import type {LayerStudioResultDocument} from "../../../../shared/layer-studio";
import {orderedLayerStudioItems,validLayerStudioSize,type LayerStudioEditDocument,type LayerStudioGroup,type LayerStudioImageReader} from "./layer-composition";

export async function exportLayerStudioPsd(result:LayerStudioResultDocument,edit:LayerStudioEditDocument,group:LayerStudioGroup,read:LayerStudioImageReader,signal:AbortSignal,progress:(done:number,total:number)=>void){
    signal.throwIfAborted();
    if(edit.taskId!==result.taskId||!group.size||result.status!=="ready"||result.items.length!==result.expectedOutputCount||result.items.some(i=>i.state!=="saved"))throw Error("原件尚未全部保存，不能导出 PSD");
    const layers=new Map(edit.layers.map(l=>[l.index,l]));
    const items=orderedLayerStudioItems(group,edit),bounds={...group.size};
    const shape=items.map(item=>{
        const layer=layers.get(item.index);
        if(!layer||![layer.x,layer.y,layer.width,layer.height].every(Number.isFinite)||layer.width<=0||layer.height<=0)throw Error("图层位置或尺寸无效");
        return {item,layer,left:Math.round(layer.x),top:Math.round(layer.y),width:Math.max(1,Math.round(layer.width)),height:Math.max(1,Math.round(layer.height))};
    });
    if(!items.length||!validLayerStudioSize(bounds)||[bounds,...shape].some(s=>!validLayerStudioSize(s)||s.width>30000||s.height>30000)||shape.reduce((n,s)=>n+s.width*s.height,bounds.width*bounds.height)>24_000_000)throw Error("图层总尺寸超出 PSD 本地导出上限，请缩小画布或图层");
    const canvases:HTMLCanvasElement[]=[];
    const canvas=(w:number,h:number)=>{const c=document.createElement("canvas");c.width=w;c.height=h;canvases.push(c);return c;};
    try{
        const composite=canvas(bounds.width,bounds.height),ctx=composite.getContext("2d");
        if(!ctx)throw Error("浏览器无法创建图层画布");
        const children:Layer[]=[];
        for(const [i,s] of shape.entries()){
            signal.throwIfAborted();progress(i,shape.length);
            const original=await read(s.item,signal);
            try{
                signal.throwIfAborted();
                const c=canvas(s.width,s.height),layerContext=c.getContext("2d");
                if(!layerContext)throw Error("浏览器无法创建图层画布");
                layerContext.imageSmoothingQuality="high";layerContext.drawImage(original.image,0,0,s.width,s.height);
                if(s.layer.visible)ctx.drawImage(c,s.left,s.top);
                children.push({name:s.item.name||s.item.role+" "+(s.item.index+1),left:s.left,top:s.top,hidden:!s.layer.visible,canvas:c});
            }finally{original.dispose();}
        }
        progress(shape.length,shape.length);await new Promise<void>(ok=>setTimeout(ok,0));signal.throwIfAborted();
        return new Blob([writePsd({...bounds,canvas:composite,children},{trimImageData:false})],{type:"image/vnd.adobe.photoshop"});
    }finally{for(const c of canvases){c.width=1;c.height=1;}}
}
