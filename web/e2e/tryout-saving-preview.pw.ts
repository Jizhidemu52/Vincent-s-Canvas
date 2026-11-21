import {expect,test,fixturePng} from "./fixtures";

test("shows an owned preview before storage, reopens it and repairs only the original",async({page,api},info)=>{
    const project="f1000000-0000-4000-8000-000000000001",task="f1000000-0000-4000-8000-000000000002",owner="00000000-0000-4000-8000-000000000099",now=new Date().toISOString(),requestId="tryout:"+owner+":preview-fixture";
    const node={id:"preview",type:"image",title:"试色方案",position:{x:160,y:170},width:260,height:220,metadata:{status:"loading",tryout:{version:1,kind:"color",tier:"quick",rootNodeId:"source",sourceNodeId:"source",prompt:"酒红",timing:{droppedAt:Date.now()},color:{name:"酒红",hex:"#672740"}},imageTask:{taskId:task,projectId:project,ownerId:owner,requestId,resultIndex:0}}};
    api.documents.set(project,{id:project,revision:1,deleted:false,updatedAt:now,document:{id:project,title:"原图保存验证",createdAt:now,updatedAt:now,nodes:[node],connections:[],groups:[],viewport:{x:0,y:0,k:1},backgroundMode:"dots",showImageInfo:false,chatSessions:[],activeChatId:null,history:{past:[],future:[]}}});
    api.tasks.set(task,{id:task,userId:owner,requestId,status:"processing",resultUrls:[],createdAt:now,failureReason:null});
    const png=fixturePng(90),webp=await page.evaluate(async(encoded)=>{
        const im=new Image();im.src="data:image/png;base64,"+encoded;await im.decode();
        const c=document.createElement("canvas");c.width=c.height=256;c.getContext("2d")!.drawImage(im,0,0);return c.toDataURL("image/webp").split(",")[1];
    },png.toString("base64"));
    let state="saving",resumes=0,gets=0;
    await page.route("**/api/deployment",r=>r.fulfill({json:{authenticationEnabled:true,creditsEnabled:false,rolePortalsEnabled:false,oaLoginEnabled:false,tryoutDisplayBeforeSave:true}}));
    await page.route("**/api/tryout/results/*/preview",r=>{expect(r.request().headers()["x-canvas-owner-id"]).toBe(owner);if(r.request().method()==="GET")gets++;return r.fulfill({body:Buffer.from(webp,"base64"),contentType:"image/webp",headers:{"X-Tryout-Save-State":state,"Cache-Control":"private, no-store"}});});
    await page.route("**/api/tasks/"+task+"/recover",r=>{expect(r.request().method()).toBe("POST");expect(r.request().headers()["x-canvas-owner-id"]).toBe(owner);resumes++;return r.fulfill({json:{task:{id:task},recovered:true}});});
    await page.goto("/canvas/"+project);
    const preview=page.getByTestId("tryout-result-preview");
    await expect(preview).toContainText("正在保存原图");await expect.poll(()=>preview.locator("img").evaluate(el=>(el as HTMLImageElement).naturalWidth)).toBe(256);
    await expect(preview.locator("img")).toHaveAttribute("src",/^blob:/);
    expect(JSON.stringify(api.document(project))).not.toMatch(/blob:|temporary-preview|data:image/);
    await page.screenshot({path:info.outputPath("before-save.png")});
    state="retryable";await page.reload();await expect(preview.getByRole("button",{name:"重试保存"})).toBeVisible();
    await preview.getByRole("button",{name:"重试保存"}).click();await expect(preview).toContainText("不会重新生成");
    await expect(preview.getByRole("button",{name:"重试保存"})).toBeDisabled();
    const current=api.tasks.get(task)!;api.assetBytes.set(task,png);Object.assign(current,{status:"success",resultUrls:["/api/assets/"+task+"/content"],completedAt:now});
    await expect.poll(()=>api.document(project)?.nodes[0]?.metadata.status,{timeout:35000}).toBe("success");
    await expect(preview).toHaveCount(0);expect(resumes).toBe(1);expect(gets).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(api.document(project))).not.toMatch(/blob:|temporary-preview|data:image/);expect(api.submissions).toHaveLength(0);
});
