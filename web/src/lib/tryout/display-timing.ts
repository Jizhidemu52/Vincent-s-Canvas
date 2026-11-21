import {useUserStore} from "@/stores/use-user-store";

type Sample={owner:string;droppedAt:number;submittedAt:number;pending?:boolean};
const tracked=new Map<string,Sample>();

export function trackQuickDisplay(task:string,owner:string,droppedAt:number,submittedAt:number){
    if(droppedAt<performance.timeOrigin||droppedAt>submittedAt||document.visibilityState!=="visible")return;
    if(tracked.size>=200)tracked.delete(tracked.keys().next().value!);
    tracked.set(task,{owner,droppedAt,submittedAt});
}
export function observeQuickDisplay(img:HTMLImageElement,task:string|undefined,source:"original"|"preview"){
    const sample=task&&tracked.get(task);
    if(!task||!sample||sample.pending)return;
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
        if(tracked.get(task)!==sample||sample.pending||useUserStore.getState().user?.id!==sample.owner||document.visibilityState!=="visible"||!img.isConnected||!img.naturalWidth)return;
        const r=img.getBoundingClientRect(),shownAt=Date.now();
        if(r.width<=0||r.height<=0||r.bottom<=0||r.right<=0||r.left>=innerWidth||r.top>=innerHeight||shownAt<sample.submittedAt||shownAt-sample.droppedAt>3600_000)return;
        sample.pending=true;
        void fetch("/api/tryout/results/"+encodeURIComponent(task)+"/display",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Canvas-Owner-Id":sample.owner},body:JSON.stringify({droppedAt:sample.droppedAt,submittedAt:sample.submittedAt,shownAt,source})})
            .then(r=>{if(r.ok)tracked.delete(task);}).catch(()=>{}).finally(()=>{sample.pending=false;});
    }));
}
