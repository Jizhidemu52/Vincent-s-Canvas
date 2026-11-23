import {TryoutSwatch,type DropColor,type TryoutChip} from "./tryout-swatch";
import { TryoutPalette } from "./tryout-palette";
import {TryoutMaterials} from "./tryout-materials";
import {TryoutModels} from "./tryout-models";
import {useTryoutBatch} from "./use-tryout-batch";
import {useLayoutEffect,useState,type RefObject} from "react";
import {App} from "antd";
import {outfitDrop} from "./tryout-outfit-drop";
import { ChevronUp } from "lucide-react";
import "./tryout-workbench.css";
import {TryoutAdjustments} from "./tryout-adjustments";
import {useWorkbenchKit} from "./tryout-material-kit";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasGraphField } from "@/stores/canvas/canvas-graph-store";
import { useUiText } from "@/lib/i18n";
import { CanvasImageQuickActions } from "../canvas-image-quick-actions";
import type { CanvasNodeData } from "@/types/canvas";
import type { QuickImageAction } from "@/lib/quick-image-tools";
import type { TryoutBoardOptions } from "../../../../../shared/tryout";

export function CanvasDesignToolbox({node,count,selectedCount,onRun,onBoard,onClose,writable,beforeEdit,onColor,nodesRef,outfitRef}: {
    nodesRef:RefObject<CanvasNodeData[]>;outfitRef:RefObject<ReturnType<typeof outfitDrop>>;
    node?:CanvasNodeData;count:number;selectedCount:number;
    onRun:(node:CanvasNodeData,action:QuickImageAction)=>Promise<void>;
    onBoard:(options?:Partial<TryoutBoardOptions>)=>Promise<void>;
    onClose:()=>void;
    onColor:DropColor;
    writable:{current:boolean};beforeEdit:()=>void;
}) {
    const theme=canvasThemes[useThemeStore(s=>s.theme)];
    const ui=App.useApp();
    useLayoutEffect(()=>{outfitRef.current=outfitDrop(nodesRef,writable,ui,onColor);},[nodesRef,writable,ui,onColor,outfitRef]);
    const [tab,setTab]=useCanvasGraphField("toolboxTab");
    const [busy,setBusy]=useState(false);
    const [groupNotice,setGroupNotice]=useState("");
    const [pending,setPending]=useState<{id:string;patch:Partial<TryoutBoardOptions>}>();
    const t=useUiText();
    const discussion=tab==="discussion";
    const shelf=useWorkbenchKit(),batch=useTryoutBatch(onColor,writable),selectedProduct=batch.products[0];
    const groupButton=(chips:TryoutChip[],label:string)=>chips[0]&&<TryoutSwatch selectedId={selectedProduct} color={chips[0]} groupLabel={label+" · "+Math.min(12,(batch.products.length||1)*chips.length)+" "+t("款")} onDrop={(id,_chip,region)=>batch.group(id,chips,region)} writable={writable} notice={setGroupNotice}/>;
    const saved=node?.metadata?.proposalBoard;
    const board=saved?.version===2 && pending && pending.id===node?.id ? {...saved,...pending.patch} : saved;
    const run=async(options?:Partial<TryoutBoardOptions>)=>{
        if(!count||busy)return;
        setBusy(true);
        if(node&&options)setPending({id:node.id,patch:options});
        try{await onBoard(options);}finally{setPending(undefined);setBusy(false);}
    };
    return <aside aria-label={t("设计工具箱")} data-testid="canvas-design-toolbox"
        className={discussion?"absolute right-3 top-16 z-[75] w-[430px] max-w-[calc(100%-24px)] rounded-xl border text-xs max-[760px]:right-2 max-[760px]:top-[108px]":"tryout-bench"}
        style={discussion?{background:theme.toolbar.panel,color:theme.node.text,borderColor:theme.toolbar.border}:undefined}
        onPointerDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()}>
        {discussion?<div className="flex items-center gap-1 px-2 py-1">
            <button type="button" aria-pressed={!discussion} onClick={()=>setTab("toolbox")} className="min-h-9 rounded-md px-2" style={{fontWeight:discussion?400:650}}>{t("工具箱")}</button>
            <button type="button" aria-pressed={discussion} onClick={()=>setTab("discussion")} className="min-h-9 rounded-md px-2" style={{fontWeight:discussion?650:400}}>{t("设计讨论")}</button>
            <button type="button" aria-label={t("收起试款台")} onClick={onClose} className="ml-auto grid size-8 place-items-center"><ChevronUp size={15}/></button>
        </div>:<header className="tb-head"><strong>{t("试款台")}</strong><span title={node?.title}>{node?.title||t(selectedCount?"已选多项":"未选中")}</span></header>}
        {!discussion?<div className="tb-scroll">
            <h4>{t("1 试色")}<em>{t("快速出款")}</em></h4>
            <p className="tb-hint">{t("把颜色拖到产品上，旁边直接出这个颜色的款。原款不动。")}</p>
            <TryoutPalette shelf={shelf} selectedId={selectedProduct} onColor={batch.apply} writable={writable} beforeEdit={beforeEdit} group={groupButton(shelf.kit.colors,t("试整组色板"))}/>
            <h4>{t("2 试材质")}<em>{t("快速出款")}</em></h4>
            <p className="tb-hint">{t("把材质拖到产品上，款式版型不变，只换材质。")}</p>
            <TryoutMaterials productCount={batch.products.length} shelf={shelf} selectedId={selectedProduct} onColor={batch.apply} writable={writable} beforeEdit={beforeEdit} group={groupButton(shelf.kit.materials,t("试整组材质"))}/>
            {groupNotice&&<p role="status">{groupNotice}</p>}
            <h4>{t("3 上身")}<em>{t("快速上身")}</em></h4>
            <p className="tb-hint">{t("把模特拖到某一款上，上身图出现在这一款的正下方。不选模特也行，系统自动配。")}</p>
            <TryoutModels nodeId={selectedProduct} count={batch.products.length} writable={writable} onDrop={batch.apply}/>
            <h4>{t("4 出提案")}<em>{t("即时")}</em></h4>
            {board?.version===2 ? <fieldset className="grid gap-2" disabled={busy||node?.metadata?.locked}>
                <legend className="mb-2 font-semibold">{t("提案板排版")}</legend>
                <label>{t("每行款数")} <select aria-label={t("每行款数")} value={board.columns} onChange={e=>void run({columns:Number(e.target.value) as TryoutBoardOptions["columns"]})}>{([2,3,4,5,6] as const).map(n=><option key={n}>{n}</option>)}</select></label>
                <label>{t("版面")} <select aria-label={t("版面")} value={board.orientation} onChange={e=>void run({orientation:e.target.value==="portrait"?"portrait":"landscape"})}><option value="landscape">{t("横版")}</option><option value="portrait">{t("竖版")}</option></select></label>
                <label><input type="checkbox" checked={board.showWear} onChange={e=>void run({showWear:e.target.checked})}/> {t("带上身图")}</label>
                <label><input type="checkbox" checked={board.showCode} onChange={e=>void run({showCode:e.target.checked})}/> {t("显示色号")}</label>
            </fieldset> : <button type="button" disabled={!count||busy} onClick={()=>void run()} className="tb-wide" aria-label={t("出提案板")}>
                {t(busy?"正在排版":"出提案板")}
            </button>}
            <p className="tb-why">{t(selectedCount&&!count?"这个工具只对图片可用":"选中一件产品，自动收齐它的各色款，每款下面对应它的上身图")}{!count&&!selectedCount&&<span className="sr-only">{t("选中图片后可用")}</span>}</p>
            <TryoutAdjustments node={node} writable={writable} beforeEdit={beforeEdit}/>
            <div className="tb-extra"><button type="button" onClick={()=>setTab("discussion")}>{t("设计讨论")}</button><button type="button" aria-label={t("收起试款台")} onClick={onClose}>{t("收起试款台")}</button></div>
            {count>8?<p className="mb-2" style={{color:theme.node.muted}}>{t("已取前 8 张，其余可再生成一页")}</p>:null}
            {node?<div className="mt-2 border-t pt-3" style={{borderColor:theme.toolbar.border}}><CanvasImageQuickActions embedded key={node.id} node={node} onRun={onRun}/></div>:null}
        </div>:null}
    </aside>;
}
