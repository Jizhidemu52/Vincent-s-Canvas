import type {CanvasNodeData} from "@/types/canvas";
import {useCanvasGraphSetter} from "@/stores/canvas/canvas-graph-store";
import {useUiText} from "@/lib/i18n";
const channels=[["brightness","亮度",60,140],["contrast","对比度",60,140],["saturate","饱和度",0,200]] as const;
export function TryoutAdjustments({node,writable,beforeEdit}:{node?:CanvasNodeData;writable:{current:boolean};beforeEdit:()=>void}){
    const t=useUiText(),setNodes=useCanvasGraphSetter("nodes"),disabled=!node||node.metadata?.locked||!writable.current;
    const change=(channel?:typeof channels[number][0],value=100)=>{
        if(!node||disabled||!writable.current)return;
        beforeEdit();setNodes(items=>items.map(n=>n.id===node.id&&!n.metadata?.locked?{...n,metadata:{...n.metadata,tryoutTone:channel?{...n.metadata?.tryoutTone,[channel]:value}:undefined}}:n));
    };
    return <><h4>{t("调整")}<em>{t("即时")}</em></h4><fieldset disabled={disabled} aria-label={t("画布预览调整")}>{channels.map(([key,name,min,max])=><label className="tb-slider" key={key}><span>{t(name)}</span><input type="range" min={min} max={max} value={node?.metadata?.tryoutTone?.[key]??100} onChange={e=>change(key,e.currentTarget.valueAsNumber)}/><output>{(node?.metadata?.tryoutTone?.[key]??100)-100}</output></label>)}<button className="tb-link" type="button" onClick={()=>change()}>{t("恢复原样")}</button></fieldset></>;
}
