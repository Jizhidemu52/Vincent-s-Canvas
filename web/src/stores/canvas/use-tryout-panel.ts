import { useCallback, useState } from "react";

export function useTryoutPanel(enabled:boolean, owner:string) {
    const key = "canvas-tryout:open:"+owner;
    const [open,setOpen]=useState(()=>{try{return localStorage.getItem(key)==="true";}catch{return false;}});
    const change=useCallback((value:boolean)=>{
        if(!enabled)return;
        setOpen(value);
        try{localStorage.setItem(key,String(value));}catch{}
    },[enabled,key]);
    const toggle=useCallback(()=>change(!open),[open,change]);
    return {open:enabled&&open,change,toggle};
}
