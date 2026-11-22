import {TryoutSwatch,prewarmVisibleRegions,type DropColor} from "./tryout-swatch";
import { lazy, Suspense, useEffect, useState,type ReactNode } from "react";
import { editKit, type TryoutKit } from "../../../../../shared/tryout-kit";
import type {WorkbenchKit} from "./tryout-material-kit";
import { useUiText } from "@/lib/i18n";

const ColorLibrary=lazy(()=>import("./tryout-color-library"));
export type KitColor=TryoutKit["colors"][number];

export function TryoutPalette({writable,beforeEdit,onColor,selectedId,group,shelf}:{shelf:WorkbenchKit;group:ReactNode;selectedId?:string;onColor:DropColor;writable:{current:boolean};beforeEdit:()=>void}){
    const t=useUiText(),{kit,setKit}=shelf;
    const [open,setOpen]=useState(false),[notice,setNotice]=useState("");
    useEffect(prewarmVisibleRegions,[]);
    const edit=(color:KitColor|null,replaceId?:string)=>{
        if(!writable.current){setNotice(t("此画布当前不可编辑"));return;}
        if(!shelf.canEdit){setNotice(t(shelf.error?"无法读取材质库":"正在读取材质库"));return;}
        try{
            const colors=editKit(kit.colors,color,replaceId);
            beforeEdit();
            setKit({...kit,colors});
            setNotice("");setOpen(false);
        }catch(error){setNotice(error instanceof Error?error.message:t("未更改色板"));}
    };
    return <section aria-label={t("企划色板")}>
        <div className="tb-palhead"><span>{t("企划色板")}</span><div><button type="button" className="tb-link" onClick={()=>{setNotice("");setOpen(true);}}>{t("从色库换颜色")}</button>{group}</div></div>
        <div className="tb-swatches">
            {kit.colors.map(c=><div key={c.id} className="tb-cell" title={[c.name,c.code,c.hex].filter(Boolean).join(" · ")}>
                <TryoutSwatch selectedId={selectedId} color={c} onDrop={onColor} writable={writable} notice={setNotice}/>
                <button type="button" aria-label={t("移除")+" "+c.name} className="tb-remove" onClick={()=>edit(null,c.id)}>×</button>
            </div>)}
        </div>
        {!kit.colors.length&&<p className="tb-hint">{t("企划色板是空的，点「从色库换颜色」加几个")}</p>}
        {open?<Suspense fallback={<span role="status">{t("正在打开色库")}</span>}><ColorLibrary colors={kit.colors} onEdit={edit} onClose={()=>setOpen(false)} notice={notice}/></Suspense>:notice?<span role="status">{notice}</span>:null}
    </section>;
}
