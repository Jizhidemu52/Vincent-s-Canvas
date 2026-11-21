import {useUserStore} from "@/stores/use-user-store";
import {readMediaSource,readUploadedMedia,serverMediaId} from "@/services/canvas-media-links";

const recent=new Map<string,number>();
export async function prewarmTryoutSource(source:string,owner:string|undefined,current:()=>boolean){
    if(!owner||!source||!current()||useUserStore.getState().user?.id!==owner)return;
    try{
        const assetId=/^[0-9a-f-]{36}$/i.test(source)?source:serverMediaId(source)||(
            source.startsWith("image:")?serverMediaId(await readMediaSource(source)||await readUploadedMedia(owner,source)||""):"");
        if(!assetId||!current()||useUserStore.getState().user?.id!==owner)return;
        const now=Date.now(),key=owner+":"+assetId;
        if((recent.get(key)??0)>now)return;
        for(const [k,until] of recent)if(until<=now)recent.delete(k);
        recent.set(key,now+60_000);
        const res=await fetch("/api/tryout/prewarm",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Canvas-Owner-Id":owner},body:JSON.stringify({assetId})});
        if(res.ok)recent.set(key,Date.now()+15*60_000);
    }catch{}
}
