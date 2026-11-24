import {lazy,Suspense,useRef,useState,type ReactNode} from "react";
import {editKit} from "../../../../../shared/tryout-kit";
import type {WorkbenchKit} from "./tryout-material-kit";
import {FabricSample} from "./tryout-fabric-sample";
import {TryoutSwatch,type DropColor,type KitMaterial} from "./tryout-swatch";
import {useUiText} from "@/lib/i18n";

const Library=lazy(()=>import("./tryout-material-library"));
export function TryoutMaterials({writable,beforeEdit,onColor,selectedId,productCount,shelf,group}:{productCount:number;shelf:WorkbenchKit;group:ReactNode;selectedId?:string;writable:{current:boolean};beforeEdit:()=>void;onColor:DropColor}){
    const t=useUiText(),{kit,setKit}=shelf;
    const [open,setOpen]=useState(false),[notice,setNotice]=useState("");
    const [choice,choose]=useState<string>(),[applying,setApplying]=useState(false),lock=useRef(false);
    const selected=kit.materials.find(m=>m.id===choice);
    const edit=(entry:KitMaterial|null,id?:string)=>{
        if(!writable.current){setNotice(t("此画布当前不可编辑"));return;}
        if(!shelf.canEdit){setNotice(t(shelf.error?"无法读取材质库":"正在读取材质库"));return;}
        try{const materials=editKit(kit.materials,entry,id);beforeEdit();setKit({...kit,materials});setOpen(false);setNotice("");}
        catch(error){setNotice(error instanceof Error?error.message:t("未更改材质"));}
    };
    const openLib=()=>{setNotice("");setOpen(true);};
    return <section aria-label={t("企划材质")}>
        <div className="tb-palhead"><span>{t("企划材质")}</span><div><button type="button" className="tb-link" onClick={openLib}>{t("从材质库换材质")}</button>{group}</div></div>
        <div className="tb-pats">{kit.materials.map(m=><div key={m.id} className="tb-cell"><TryoutSwatch selectedId={selectedId} color={m} chosen={m.id===selected?.id} onChoose={()=>{choose(m.id);setNotice("");}} onDrop={onColor} notice={setNotice} writable={writable}><FabricSample presetId={m.presetId} photo={m.assetId?"/api/assets/"+m.assetId+"/thumb?w=256":shelf.presets.find(p=>p.id===m.presetId)?.thumbAssetId?"/api/materials/presets/"+m.presetId+"/thumb":undefined}/><span>{m.name}</span></TryoutSwatch><button type="button" aria-label={t("移除材质")+" "+m.name} onClick={()=>edit(null,m.id)} className="tb-remove">×</button></div>)}</div>
        {selected?<button type="button" className="tb-wide" disabled={!selectedId||!writable.current||applying} onClick={async()=>{if(!selectedId||!writable.current||lock.current)return;lock.current=true;setApplying(true);try{await onColor(selectedId,selected,Date.now());}finally{lock.current=false;setApplying(false);}}}>{t("换材质")} · {selected.name} · {productCount} {t("款")}</button>:null}
        {shelf.error?<p role="status">{t("无法读取材质库")} <button onClick={shelf.retry}>{t("重试")}</button></p>:shelf.loading?<p className="tb-hint">{t("正在读取材质库")}</p>:!kit.materials.length?<p className="tb-hint">{t("企划里尚无材质，可从材质库添加。")}</p>:null}
        {!kit.materials.length&&shelf.defaults.length>0&&<button type="button" className="tb-link" onClick={()=>{if(writable.current){beforeEdit();setKit({...kit,materials:shelf.defaults});}}}>{t("加入样机默认材质")}</button>}
        {open?<Suspense fallback={<span role="status">{t("正在打开材质库")}</span>}><Library materials={kit.materials} onEdit={edit} onClose={()=>setOpen(false)} notice={notice}/></Suspense>:notice?<span role="status">{notice}</span>:null}
    </section>;
}
