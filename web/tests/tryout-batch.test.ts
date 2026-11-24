import {expect,test} from "bun:test";
import {batchTryout,type BatchJob} from "../src/lib/tryout/batch";
import type {DropColor} from "../src/components/canvas/toolbox/tryout-swatch";
const jobs=(n:number):BatchJob[]=>Array.from({length:n},(_,i)=>({nodeId:"p"+i,chip:{name:"上身",model:{auto:true}}}));
test("the batch issues at most twelve independent receipts; locally rejected items do not block the rest",async()=>{
    const received=new Map<string,number>(),sent:string[]=[];
    const drop:DropColor=async(id,_chip,_at,send)=>{
        if(id==="p2")return;
        const res=await send!({kind:"wear",tier:"quick",canvasId:"canvas",nodeId:id,requestId:id,model:{auto:true},productAssetIds:["original"]},"staff",()=>id!=="p3");
        received.set(id,res.status);
    };
    const fetcher=async(_url:unknown,init?:RequestInit)=>{
        const {items}=JSON.parse(init?.body as string);sent.push(...items.map((i:{nodeId:string})=>i.nodeId));
        return Response.json({tasks:items.filter((i:{nodeId:string})=>i.nodeId!=="p6").map((i:{requestId:string})=>({requestId:i.requestId,taskId:"task"+i.requestId})).reverse()});
    };
    const r=await batchTryout(jobs(15),drop,"staff",()=>true,fetcher as typeof fetch);
    expect(r).toMatchObject({planned:12,sent:10,unknown:1,rejected:2,truncated:true});expect(r.accepted.length).toBe(9);expect(received.get("p6")).toBe(503);
    expect(received.get("p3")).toBe(409);expect(received.has("p2")).toBe(false);expect(sent.includes("p12")).toBe(false);
});
test("cancelling before the batch dispatches creates no task even if some slots finished preparing",async()=>{
    let sends=0;
    const r=await batchTryout(jobs(2),async(id,_chip,_at,send)=>{const res=await send!({kind:"wear",tier:"quick",canvasId:"canvas",nodeId:id,requestId:id,model:{auto:true},productAssetIds:["original"]},"staff",()=>true);expect(res.status).toBe(409);},"staff",()=>false,(async()=>{sends++;return Response.json({});}) as typeof fetch);
    expect(sends).toBe(0);expect(r).toMatchObject({sent:0,rejected:2,accepted:[],unknown:0});
});
