import {lazy,Suspense,useState} from "react";
import {editKit,KIT_MAX} from "../../../../../shared/tryout-kit";
import {useCanvasGraphField} from "@/stores/canvas/canvas-graph-store";
import {initialKit} from "./tryout-palette";
import {TryoutSwatch,type DropColor,type KitMaterial} from "./tryout-swatch";
import {useUiText} from "@/lib/i18n";

const Library=lazy(()=>import("./tryout-material-library"));
export function TryoutMaterials({writable,beforeEdit,onColor}:{writable:{current:boolean};beforeEdit:()=>void;onColor:DropColor}){
    const t=useUiText(),[stored,setKit]=useCanvasGraphField("tryoutKit"),kit=stored??initialKit;
    const [open,setOpen]=useState(false),[notice,setNotice]=useState("");
    const edit=(entry:KitMaterial|null,id?:string)=>{
        if(!writable.current){setNotice(t("此画布当前不可编辑"));return;}
        try{const materials=editKit(kit.materials,entry,id);beforeEdit();setKit({...kit,materials});setOpen(false);setNotice("");}
        catch(error){setNotice(error instanceof Error?error.message:t("未更改材质"));}
    };
    return <section aria-label={t("企划材质")} className="mb-4 border-t border-current/10 pt-2">
        <div className="mb-2 flex justify-between"><strong>{t("企划材质")}</strong><span>{kit.materials.length} / {KIT_MAX}</span></div>
        <div className="grid grid-cols-2 gap-1">{kit.materials.map(m=><div key={m.id} className="flex min-w-0 items-center"><TryoutSwatch color={m} onDrop={onColor} notice={setNotice} writable={writable}/><button type="button" aria-label={t("移除材质")+" "+m.name} onClick={()=>edit(null,m.id)} className="px-1">×</button></div>)}</div>
        <button type="button" className="min-h-9" onClick={()=>{setNotice("");setOpen(true);}}>{t("从材质库换材质")}</button>
        {open?<Suspense fallback={<span role="status">{t("正在打开材质库")}</span>}><Library materials={kit.materials} onEdit={edit} onClose={()=>setOpen(false)} notice={notice}/></Suspense>:notice?<span role="status">{notice}</span>:null}
    </section>;
}
