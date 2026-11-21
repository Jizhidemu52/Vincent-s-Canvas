import {useDeferredValue,useEffect,useMemo,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {loadStandardColors, type StandardColor} from "@/lib/standard-colors";
import {canvasThemes} from "@/lib/canvas-theme";
import {useThemeStore} from "@/stores/use-theme-store";
import {useUiText} from "@/lib/i18n";
import type {KitColor} from "./tryout-palette";
import {KIT_MAX} from "../../../../../shared/tryout-kit";

const rowHeight=44,columns=3;
function hue(hex:string){
    const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255);
    const hi=Math.max(r,g,b),lo=Math.min(r,g,b),d=hi-lo;
    if(d<.065)return 6;
    const h=hi===r?(g-b)/d:hi===g?2+(b-r)/d:4+(r-g)/d;
    return Math.floor(((h+6+.5)%6));
}
export default function TryoutColorLibrary({colors,onEdit,onClose,notice}:{colors:KitColor[];onEdit:(color:KitColor,replaceId?:string)=>void;onClose:()=>void;notice:string}){
    const t=useUiText(), theme=canvasThemes[useThemeStore(s=>s.theme)],dialog=useRef<HTMLDialogElement>(null),list=useRef<HTMLDivElement>(null);
    const [data,setData]=useState<StandardColor[]>([]),[status,setStatus]=useState("loading"),[attempt,setAttempt]=useState(0),[chosen,setChosen]=useState<KitColor>();
    const [query,setQuery]=useState(""),q=useDeferredValue(query.trim().toLowerCase()),[family,setFamily]=useState(-1),[scroll,setScroll]=useState(0);
    useEffect(()=>{const d=dialog.current;d?.showModal();return()=>d?.close();},[]);
    useEffect(()=>{let live=true;setStatus("loading");loadStandardColors().then(v=>{if(live){setData(v);setStatus("ready");}},()=>{if(live)setStatus("error");});return()=>{live=false;};},[attempt]);
    const indexed=useMemo(()=>data.map(c=>({c,group:hue(c.hex),text:[c.name,c.alias,c.hex,c.brand,...c.libraries].join(" ").toLowerCase()})),[data]);
    const hits=useMemo(()=>indexed.filter(x=>(family===-1||x.group===family)&&(!q||x.text.includes(q))),[indexed,family,q]);
    useEffect(()=>{if(list.current)list.current.scrollTop=0;setScroll(0);},[q,family]);
    const start=Math.max(0,Math.floor(scroll/rowHeight)-1)*columns;
    return createPortal(<dialog ref={dialog} aria-label={t("企划色库")} onCancel={e=>{e.preventDefault();onClose();}} className="fixed inset-0 m-auto w-[min(540px,94vw)] max-h-[90dvh] overflow-y-auto rounded-xl border p-4 backdrop:bg-black/35"
        style={{color:theme.node.text,background:theme.toolbar.panel,borderColor:theme.toolbar.border}} onPointerDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between"><h2 className="text-base font-semibold">{t("企划色库")}</h2><button type="button" onClick={onClose}>{t("关闭")}</button></div>
        <label className="grid gap-1">{t("搜索色号、颜色或色库")}<input type="search" value={query} onChange={e=>setQuery(e.target.value)} className="min-h-9 rounded border bg-transparent px-2"/></label>
        <label className="my-2 inline-flex gap-2">{t("色相")}<select value={family} onChange={e=>setFamily(Number(e.target.value))}>{["全部","红","黄","绿","青","蓝","紫","中性色"].map((n,i)=><option key={n} value={i-1}>{t(n)}</option>)}</select></label>
        {status==="error"?<button type="button" onClick={()=>setAttempt(v=>v+1)}>{t("色库加载失败，点击重试")}</button>:status==="loading"?<p role="status">{t("正在加载颜色")}</p>:<>
            <small aria-live="polite">{hits.length} {t("个颜色")}</small>
            <div ref={list} onScroll={e=>setScroll(e.currentTarget.scrollTop)} className="relative h-[220px] overflow-auto" aria-label={t("色库结果")}>
                <div style={{height:Math.ceil(hits.length/columns)*rowHeight}}/>
                <div className="absolute inset-x-0 grid grid-cols-3" style={{top:Math.floor(start/columns)*rowHeight}}>
                    {hits.slice(start,start+8*columns).map(({c})=><button key={c.id} type="button" aria-pressed={chosen?.id===c.id} title={[c.name,c.alias,c.hex].filter(Boolean).join(" · ")} style={{height:rowHeight}} className="flex min-w-0 items-center gap-1.5 rounded p-1 text-left aria-pressed:outline-2 aria-pressed:-outline-offset-2" onClick={()=>setChosen({id:c.id,name:c.alias||c.name,hex:c.hex,library:c.brand,code:c.name})}><i className="size-5 shrink-0 rounded-sm" style={{background:c.hex}}/><span className="truncate text-xs">{c.name}</span></button>)}
                </div>
            </div>
        </>}
        <fieldset disabled={!chosen} className="mt-3 border-t pt-2 disabled:opacity-50"><legend className="text-xs">{chosen?chosen.name+" · "+chosen.hex:t("先选颜色，再选择放入的位置")}</legend>
            <div className="flex flex-wrap gap-2">{colors.map(c=><button key={c.id} type="button" className="min-h-8 rounded border px-2" aria-label={t("替换")+" "+c.name} onClick={()=>chosen&&onEdit(chosen,c.id)}>{c.name}</button>)}
            <button type="button" disabled={colors.length>=KIT_MAX} className="min-h-8 rounded border px-2 disabled:opacity-45" onClick={()=>chosen&&onEdit(chosen)}>{t("加为新的")}</button></div>
        </fieldset>{notice?<p role="status">{notice}</p>:null}
    </dialog>,document.body);
}
