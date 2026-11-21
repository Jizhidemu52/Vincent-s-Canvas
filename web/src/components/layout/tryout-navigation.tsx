import {useState} from "react";
import {Link,useLocation} from "react-router-dom";
import {Box,ChevronDown,Ellipsis,Folder,Images,MessageSquare,Palette,Scissors} from "lucide-react";
import {navigationTools,type NavigationToolSlug} from "@/constant/navigation-tools";
import {buildCreativePresetHref,creativePresets} from "@/lib/creative-presets";
import {uiText} from "@/lib/i18n";
import type {ModuleKey} from "@/services/api/modules";

type Destination={label:string;path:string;enabled:boolean};
type Props={available:(slug:NavigationToolSlug)=>boolean;module:(key:ModuleKey)=>boolean;onNavigate?:()=>void};
export function TryoutNavigation({available,module,onNavigate}:Props){
    const {pathname,search}=useLocation(),location=pathname+search;
    const [manual,setManual]=useState<{location:string;open:string|null}>();
    const tool=(slug:NavigationToolSlug):Destination=>{
        const t=navigationTools.find(t=>t.slug===slug)!;return {label:t.label,path:t.path,enabled:available(slug)};
    };
    const scene=(id:string):Destination=>{
        const p=creativePresets.find(p=>p.id===id)!;return {label:p.title,path:buildCreativePresetHref(p),enabled:module(("creative-"+id) as ModuleKey)};
    };
    const groups=[
        {name:"自由画布",icon:Box,direct:true,items:[tool("canvas")]},
        {name:"对话改图",icon:MessageSquare,direct:true,items:[tool("gpt-chat")]},
        {name:"换色",icon:Palette,items:[tool("garment-colorway"),scene("pattern-colorway")]},
        {name:"改局部",icon:Scissors,items:[tool("local-restyle"),tool("image-edit")]},
        {name:"展示",icon:Images,items:[scene("virtual-try-on"),tool("back-design"),scene("sketch-to-photo")]},
        {name:"更多工具",icon:Ellipsis,items:[{label:"工作台",path:"/",enabled:true},tool("creative"),scene("text-to-style"),scene("style-to-sketch"),scene("accessory-design"),scene("pattern-craft"),scene("pattern-extract"),tool("item-extract"),tool("remove-background"),tool("layer-studio"),tool("hd-upscale"),tool("seamless-stitch"),tool("midjourney-blend"),tool("video"),tool("team"),tool("admin")]},
        {name:"资源库",icon:Folder,items:[tool("assets"),tool("prompts"),tool("my-prompts"),tool("design-library")]},
    ].map(g=>({...g,items:g.items.filter(i=>i.enabled)})).filter(g=>g.items.length>0);
    const active=(path:string)=>{const [base,query]=path.split("?");return pathname===base&&(!query||new URLSearchParams(search).get("tool")===new URLSearchParams(query).get("tool"))||base==="/canvas"&&pathname.startsWith("/canvas/");};
    const matched=groups.find(g=>g.items.some(item=>active(item.path)))?.name;
    const open=manual?.location===location?manual.open:matched;
    const row="wb-nav-link flex min-h-9 w-full items-center gap-2 rounded-lg px-3 text-left";
    return <div aria-label={uiText("设计工具导航")} className="space-y-1">{groups.map(g=>{
        const Icon=g.icon;
        if(g.direct)return <Link key={g.name} className={row} to={g.items[0]!.path} onClick={onNavigate} aria-current={matched===g.name?"page":undefined}><Icon className="size-4"/>{uiText(g.name)}</Link>;
        const shown=open===g.name;
        return <div key={g.name}><button type="button" className={row} aria-expanded={shown} onClick={()=>setManual({location,open:shown?null:g.name})}><Icon className="size-4"/><span className="flex-1">{uiText(g.name)}</span><ChevronDown className={shown?"size-3.5":"size-3.5 -rotate-90"}/></button>
            {shown&&<div className="ml-5 border-l pl-1">{g.items.map(i=><Link key={i.path} to={i.path} onClick={onNavigate} aria-current={active(i.path)?"page":undefined} className={row}>{uiText(i.label)}</Link>)}</div>}</div>;
    })}</div>;
}
