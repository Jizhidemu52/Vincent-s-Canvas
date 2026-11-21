import { readFile,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test,expect,fixturePng } from "./fixtures";

test("a moved picked variant keeps its matching image on the rendered proposal",async({page,api},info)=>{
    const project="b1000000-0000-4000-9000-000000000001";
    const now=new Date().toISOString(), cases=[
        {id:"original",file:"01-beanie.png",x:200,y:220},
        {id:"red",file:"02-cap.png",x:480,y:220},
        {id:"other",file:"03-bucket.png",x:200,y:500},
        {id:"wear",file:"06-cowl.png",x:490,y:510},
    ];
    const nodes=await Promise.all(cases.map(async(c,i)=>{
        const assetId="b1000000-0000-4000-9000-00000000000"+(i+2);
        api.assetBytes.set(assetId,process.env.TRYOUT_SAMPLE_DIR ? await readFile(join(process.env.TRYOUT_SAMPLE_DIR,c.file)) : fixturePng(40+i*45));
        return {id:c.id,type:"image",title:"试款样图",width:180,height:180,position:{x:c.x,y:c.y},metadata:{serverAssetId:assetId,status:"success",
            ...(i?{tryout:{version:1,rootNodeId:"original",sourceNodeId:i===3?"red":"original",kind:i===3?"wear":"color",tier:"quick",prompt:"隔离测试",picked:false,
                ...(i===1?{color:{name:"酒红",hex:"#79132F",code:"W-07"}}:{})}}:{})}};
    }));
    api.documents.set(project,{id:project,revision:1,deleted:false,updatedAt:now,document:{id:project,title:"试款配对",createdAt:now,updatedAt:now,nodes,connections:[],groups:[],viewport:{x:0,y:0,k:1},backgroundMode:"dots",showImageInfo:false,chatSessions:[],activeChatId:null,history:{past:[],future:[]}}});
    await page.goto("/canvas/"+project);
    await page.getByRole("button",{name:"试款台",exact:true}).click();
    const variant=page.locator('[data-node-id="red"]').first();
    await variant.click({position:{x:35,y:16}});
    await variant.hover();
    await page.getByRole("toolbar",{name:"图片工具栏",exact:true}).getByRole("button",{name:"入选",exact:true}).click();
    await expect.poll(()=>api.document(project)?.nodes.find((n:any)=>n.id==="red")?.metadata.tryout.picked).toBe(true);
    await page.locator('[data-node-id="original"]').first().click({position:{x:36,y:16}});
    await page.getByRole("button",{name:"出提案板",exact:true}).click();
    const board=()=>api.document(project)?.nodes.find((n:any)=>n.metadata?.proposalBoard);
    await expect.poll(()=>board()?.metadata.proposalBoard.version).toBe(2);
    const output=board(), spec=output.metadata.proposalBoard;
    expect(spec.cells.map((c:any)=>[c.styleNodeId,c.wearNodeIds,c.label,c.color?.code])).toEqual([["red",["wear"],"酒红","W-07"]]);
    expect(spec.items.map((i:any)=>i.nodeId)).toEqual(["red","wear"]);
    await expect(page.locator('[data-node-id="'+output.id+'"]').first()).toBeVisible();
    await page.screenshot({path:info.outputPath("paired-board-canvas.png")});
    const capture=async(name:string)=>{
        const path=board()?.metadata.content as string;
        const bytes=api.assetBytes.get(path.split("/")[3]);
        expect(bytes).toBeTruthy();
        await writeFile(info.outputPath(name+".png"),bytes!);
        await info.attach(name,{body:bytes!,contentType:"image/png"});
    };
    await capture("paired-landscape");
    await page.getByRole("combobox",{name:"版面",exact:true}).selectOption("portrait");
    await expect.poll(()=>board()?.metadata.naturalHeight).toBe(1754);
    await page.getByRole("checkbox",{name:"带上身图",exact:true}).uncheck();
    await expect.poll(()=>board()?.metadata.proposalBoard.showWear).toBe(false);
    await page.getByRole("combobox",{name:"每行款数",exact:true}).selectOption("5");
    await expect.poll(()=>board()?.metadata.proposalBoard.columns).toBe(5);
    await page.getByRole("checkbox",{name:"显示色号",exact:true}).uncheck();
    await expect.poll(()=>board()?.metadata.proposalBoard.showCode).toBe(false);
    await capture("style-only-portrait");
    expect(board().id).toBe(output.id);
    expect(board().metadata.proposalBoard.cells).toEqual(spec.cells);
    expect(api.document(project)?.nodes).toHaveLength(5);
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});
