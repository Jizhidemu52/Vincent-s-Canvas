import {TryoutSwatch,prewarmVisibleRegions,type DropColor} from "./tryout-swatch";
import { lazy, Suspense, useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { KIT_MAX, editKit, type TryoutKit } from "../../../../../shared/tryout-kit";
import { useCanvasGraphField } from "@/stores/canvas/canvas-graph-store";
import { useUiText } from "@/lib/i18n";

const ColorLibrary=lazy(()=>import("./tryout-color-library"));
export type KitColor=TryoutKit["colors"][number];
const initialColors=[
    ["海军蓝","#1F2F55"],["雾蓝","#8FA6BF"],["酒红","#7A1F2B"],["驼色","#C19A6B"],["燕麦","#D8CDB8"],["墨绿","#24463A"],
].map(([name,hex])=>({id:hex,name,hex}));
export const initialKit:TryoutKit={version:1,colors:initialColors,materials:[]};

export function TryoutPalette({writable,beforeEdit,onColor,selectedId}:{selectedId?:string;onColor:DropColor;writable:{current:boolean};beforeEdit:()=>void}){
    const t=useUiText(),[stored,setKit]=useCanvasGraphField("tryoutKit"),kit=stored??initialKit;
    const [open,setOpen]=useState(false),[notice,setNotice]=useState("");
    useEffect(prewarmVisibleRegions,[]);
    const edit=(color:KitColor|null,replaceId?:string)=>{
        if(!writable.current){setNotice(t("此画布当前不可编辑"));return;}
        try{
            const colors=editKit(kit.colors,color,replaceId);
            beforeEdit();
            setKit({...kit,colors});
            setNotice("");setOpen(false);
        }catch(error){setNotice(error instanceof Error?error.message:t("未更改色板"));}
    };
    return <section aria-label={t("企划色板")} className="mb-4">
        <div className="mb-2 flex items-baseline justify-between"><strong>{t("企划色板")}</strong><span aria-label={t("已选颜色数")}>{kit.colors.length} / {KIT_MAX}</span></div>
        <div className="grid grid-cols-3 gap-x-2 gap-y-2">
            {kit.colors.map(c=><div key={c.id} className="group relative min-w-0">
                <TryoutSwatch selectedId={selectedId} color={c} onDrop={onColor} writable={writable} notice={setNotice}/>
                <span className="block truncate pt-0.5" title={[c.name,c.code,c.hex].filter(Boolean).join(" · ")}>{c.name}</span>
                <button type="button" aria-label={t("移除")+" "+c.name} className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-[var(--cw-panel,#fff)] text-[var(--cw-text,#222)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100" onClick={()=>edit(null,c.id)}><X size={13}/></button>
            </div>)}
        </div>
        <button type="button" onClick={()=>{setNotice("");setOpen(true);}} className="mt-2 flex min-h-9 items-center gap-1.5"><Plus size={14}/>{t("从色库换颜色")}</button>
        {open?<Suspense fallback={<span role="status">{t("正在打开色库")}</span>}><ColorLibrary colors={kit.colors} onEdit={edit} onClose={()=>setOpen(false)} notice={notice}/></Suspense>:notice?<span role="status">{notice}</span>:null}
    </section>;
}
