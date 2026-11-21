import { randomUUID } from "node:crypto";
import { test, expect, IMAGE } from "./fixtures";
import { activeWorkbench } from "./headless-workbench";

test("garment validation offers only persisted bytes and downloads without another generation", async ({page, api}, info) => {
    api.taskStatus = "paused";
    await page.goto("/creative/garment-colorway");
    const pane = activeWorkbench(page);
    await pane.getByLabel("上传服装参考图", {exact:true}).setInputFiles({name:"garment.png",mimeType:"image/png",buffer:IMAGE});
    await pane.locator("button.cs-generate").click();
    await expect(pane.getByRole("button",{name:"刷新进度",exact:true})).toBeVisible();
    const task = [...api.tasks.values()][0]!;
    const assetId = randomUUID(), filename = `task-${task.id}-1-provider-original.png`;
    const original = api.assetBytes.get(task.id)!;
    let listAvailable = false, complete = false;
    const mutations: string[] = [];
    page.on("request", request => { if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/tasks")) mutations.push(request.method()); });
    await page.route(`**/api/tasks/${task.id}/review-originals`, route => route.fulfill(listAvailable ? {json:{taskId:task.id, originals:[{assetId,filename,bytes:original.length,resultIndex:0,mimeType:"image/png"}]}} : {status:503,json:{}}));
    await page.route(`**/api/assets/${assetId}/content`, route => route.fulfill({contentType:"image/png",body:complete ? original : original.subarray(0,42)}));
    Object.assign(task,{pausedKind:"needs_review",repairErrorCode:"RESULT_OUTPUT_INVALID"});
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(pane.getByRole("button",{name:"刷新原件列表"})).toBeVisible();
    listAvailable = true;
    await pane.getByRole("button",{name:"刷新原件列表"}).click();
    const button = pane.getByRole("button",{name:"下载已保存原件"});
    await button.click();
    await expect(pane.getByText("下载内容与原件记录不一致，未保存文件。")).toBeVisible();
    complete = true;
    const received = page.waitForEvent("download");
    await button.click();
    const download = await received, stream = await download.createReadStream();
    expect(download.suggestedFilename()).toBe(filename);
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).equals(original)).toBe(true);
    expect(mutations).toEqual([]);
    expect(api.submissions).toHaveLength(1);
    await page.screenshot({path:info.outputPath("garment-reviewed-original.png"),fullPage:true});
});

test("original-size reissue requires a separate confirmation and looks up a lost receipt without posting twice", async ({page,api},info) => {
    api.taskStatus="paused";
    await page.goto("/creative/garment-colorway");
    const pane=activeWorkbench(page);
    await pane.getByLabel("上传服装参考图",{exact:true}).setInputFiles({name:"garment.png",mimeType:"image/png",buffer:IMAGE});
    await pane.locator("button.cs-generate").click();
    await expect(pane.getByRole("button",{name:"刷新进度",exact:true})).toBeVisible();
    const task=[...api.tasks.values()][0]!, child=randomUUID(), confirmation="a".repeat(64);
    let posts=0;
    await page.route(`**/api/tasks/${task.id}/review-originals`, route=>route.fulfill({json:{taskId:task.id,originals:[],canCheckOriginalSize:true}}));
    await page.route(`**/api/tasks/${task.id}/original-size-reissue`,route=>{
        if (route.request().method()==="POST") {
            expect(route.request().postDataJSON()).toEqual({confirmation}); posts++;
            return route.fulfill({status:504,json:{}});
        }
        return route.fulfill({json:posts ? {task:{id:child,status:"success",output:`/api/assets/${child}/content`}} :
            {quote:{taskId:task.id,width:1024,height:896,modelName:"隔离模型",credits:3,estimatedRmb:0.5,confirmation}}});
    });
    Object.assign(task,{pausedKind:"needs_review",repairErrorCode:"RESULT_MASK_INVALID"});
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
    const check=pane.getByRole("button",{name:"按原图尺寸重出（计费）"});
    await check.click();
    const group=pane.getByRole("group",{name:"确认按原图尺寸重出"});
    await expect(group).toContainText("1024 × 896 px"); await expect(group).toContainText("3 积分");
    await group.getByRole("button",{name:"取消"}).click(); expect(posts).toBe(0);
    await check.click(); await page.screenshot({path:info.outputPath("original-size-confirmation.png"),fullPage:true});
    await group.getByRole("button",{name:"确认重出 1 张"}).click();
    await expect(pane.getByText(/未能确认是否受理/)).toBeVisible();
    await pane.getByRole("button",{name:"查询重出记录"}).click();
    await expect(pane.getByRole("link",{name:"查看重出原图"})).toHaveAttribute("href",`/api/assets/${child}/content`);
    await expect(pane.getByText(child,{exact:false})).toBeVisible();
    await expect(group).toHaveCount(0); expect(posts).toBe(1);
});
