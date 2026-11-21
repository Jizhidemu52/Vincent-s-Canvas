import type {DropColor} from "./tryout-swatch";
import { TryoutPalette } from "./tryout-palette";
import {TryoutMaterials} from "./tryout-materials";
import {TryoutModels} from "./tryout-models";
import { useState } from "react";
import { ChevronUp, LayoutPanelLeft, LoaderCircle } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasGraphField } from "@/stores/canvas/canvas-graph-store";
import { useUiText } from "@/lib/i18n";
import { CanvasImageQuickActions } from "../canvas-image-quick-actions";
import type { CanvasNodeData } from "@/types/canvas";
import type { QuickImageAction } from "@/lib/quick-image-tools";
import type { TryoutBoardOptions } from "../../../../../shared/tryout";

export function CanvasDesignToolbox({node,count,selectedCount,onRun,onBoard,onClose,writable,beforeEdit,onColor}: {
    node?:CanvasNodeData;count:number;selectedCount:number;
    onRun:(node:CanvasNodeData,action:QuickImageAction)=>Promise<void>;
    onBoard:(options?:Partial<TryoutBoardOptions>)=>Promise<void>;
    onClose:()=>void;
    onColor:DropColor;
    writable:{current:boolean};beforeEdit:()=>void;
}) {
    const theme=canvasThemes[useThemeStore(s=>s.theme)];
    const [tab,setTab]=useCanvasGraphField("toolboxTab");
    const [busy,setBusy]=useState(false);
    const [pending,setPending]=useState<{id:string;patch:Partial<TryoutBoardOptions>}>();
    const t=useUiText();
    const discussion=tab==="discussion";
    const body=!discussion;
    const saved=node?.metadata?.proposalBoard;
    const board=saved?.version===2 && pending && pending.id===node?.id ? {...saved,...pending.patch} : saved;
    const run=async(options?:Partial<TryoutBoardOptions>)=>{
        if(!count||busy)return;
        setBusy(true);
        if(node&&options)setPending({id:node.id,patch:options});
        try{await onBoard(options);}finally{setPending(undefined);setBusy(false);}
    };
    return <aside aria-label={t("设计工具箱")} data-testid="canvas-design-toolbox"
        className={"absolute right-3 z-[75] max-w-[calc(100%-24px)] rounded-xl border text-xs "+(discussion?"top-16 w-[430px] max-[760px]:right-2 max-[760px]:top-[108px] max-[760px]:max-w-[calc(100%-16px)]":"top-[76px] max-sm:top-28")+(body?" w-[232px] max-sm:w-[192px]":"")}
        style={{background:theme.toolbar.panel,color:theme.node.text,borderColor:theme.toolbar.border}}
        onPointerDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()}>
        <div className="flex items-center gap-1 px-2 py-1">
            <button type="button" aria-pressed={!discussion} onClick={()=>setTab("toolbox")} className="min-h-9 rounded-md px-2" style={{fontWeight:discussion?400:650}}>{t("工具箱")}</button>
            <button type="button" aria-pressed={discussion} onClick={()=>setTab("discussion")} className="min-h-9 rounded-md px-2" style={{fontWeight:discussion?650:400}}>{t("设计讨论")}</button>
            <button type="button" aria-label={t("收起试款台")} onClick={onClose} className="ml-auto grid size-8 place-items-center"><ChevronUp size={15}/></button>
        </div>
        {body?<div className="max-h-[min(55vh,460px)] overflow-auto border-t p-3" style={{borderColor:theme.toolbar.border}}>
            <TryoutPalette onColor={onColor} writable={writable} beforeEdit={beforeEdit}/>
            <TryoutMaterials onColor={onColor} writable={writable} beforeEdit={beforeEdit}/>
            <TryoutModels nodeId={count===1&&!node?.metadata?.proposalBoard&&node?.metadata?.tryout?.kind!=="wear"?node?.id:undefined} writable={writable} onDrop={onColor}/>
            {!count?<p className="mb-2" style={{color:theme.node.muted}}>{t(selectedCount?"这个工具只对图片可用":"选中图片后可用")}</p>:null}
            {board?.version===2 ? <fieldset className="grid gap-2" disabled={busy||node?.metadata?.locked}>
                <legend className="mb-2 font-semibold">{t("提案板排版")}</legend>
                <label>{t("每行款数")} <select aria-label={t("每行款数")} value={board.columns} onChange={e=>void run({columns:Number(e.target.value) as TryoutBoardOptions["columns"]})}>{([2,3,4,5,6] as const).map(n=><option key={n}>{n}</option>)}</select></label>
                <label>{t("版面")} <select aria-label={t("版面")} value={board.orientation} onChange={e=>void run({orientation:e.target.value==="portrait"?"portrait":"landscape"})}><option value="landscape">{t("横版")}</option><option value="portrait">{t("竖版")}</option></select></label>
                <label><input type="checkbox" checked={board.showWear} onChange={e=>void run({showWear:e.target.checked})}/> {t("带上身图")}</label>
                <label><input type="checkbox" checked={board.showCode} onChange={e=>void run({showCode:e.target.checked})}/> {t("显示色号")}</label>
            </fieldset> : <button type="button" disabled={!count||busy} onClick={()=>void run()} className="flex min-h-10 w-full items-center gap-2 rounded-md px-1 text-left disabled:opacity-60" aria-label={t("出提案板")}>
                {busy?<LoaderCircle size={16} className="animate-spin"/>:<LayoutPanelLeft size={16}/>}<strong>{t(busy?"正在排版":"出提案板")}</strong><span className="ml-auto" style={{color:theme.node.muted}}>{t("即时")}</span>
            </button>}
            {count>8?<p className="mb-2" style={{color:theme.node.muted}}>{t("已取前 8 张，其余可再生成一页")}</p>:null}
            {node?<div className="mt-2 border-t pt-3" style={{borderColor:theme.toolbar.border}}><CanvasImageQuickActions embedded key={node.id} node={node} onRun={onRun}/></div>:null}
        </div>:null}
    </aside>;
}
