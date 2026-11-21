import { randomUUID } from "node:crypto";
import { test, expect, fixturePng } from "./fixtures";
import { activeWorkbench, readWorkspaceRecords } from "./headless-workbench";
import type { SceneLog } from "../src/pages/creative/use-scene-workspace";

for (const lostReceipt of [false,true]) test(`creative fallback shows the original description and one output; lost receipt=${lostReceipt}`, async ({page, api},info) => {
    const id = randomUUID(), source = "保留菱格提花和五颗纽扣，衣身改为蓝色", bytes = fixturePng(88);
    let posts = 0, lookups = 0;
    await page.route("**/api/tasks", async route => {
        if (route.request().method() !== "POST") return route.fallback();
        const input = route.request().postDataJSON();
        posts++;
        expect(JSON.stringify(input.promptInput)).toContain(source);
        const task = {...input,id,userId:input.parameters.inputArchive.ownerId,status:"success",prompt:source,optimized:false,
            parameters:{...input.parameters,promptOptimization:{fallback:true}},resultUrls:[`/api/assets/${id}/content`],createdAt:new Date().toISOString()};
        api.tasks.set(id,task); api.assetBytes.set(id,bytes);
        return route.fulfill(lostReceipt ? {status:504,json:{message:"Gateway Timeout"}} : {status:201,json:{task}});
    });
    await page.route("**/api/tasks/by-request/*", route => {
        const task = api.tasks.get(id);
        if (!task) return route.fallback();
        expect(decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!)).toBe(task.requestId);
        lookups++;
        return route.fulfill({json:{task}});
    });
    await page.goto("/creative/text-to-style");
    const pane = activeWorkbench(page);
    await pane.getByRole("textbox",{name:"款式描述",exact:true}).fill(source);
    await pane.locator("button.cs-generate").click();
    await expect(pane.getByRole("status").filter({hasText:"已按你的原始描述生成"})).toBeVisible();
    await expect(pane.getByRole("button",{name:"下载原图",exact:true})).toBeVisible();
    await expect(pane.getByText(/暂时无法获取进度/)).toHaveCount(0);
    await expect.poll(async () => (await readWorkspaceRecords<SceneLog>(page,"creative_scene_workspaces"))
        .filter(record => record.key.startsWith("history-record:")).map(({value}) => [value.optimized,value.successCount,value.results[0]?.taskId])).toEqual([[false,1,id]]);
    expect(posts).toBe(1); expect(api.tasks.size).toBe(1); expect(lookups).toBe(lostReceipt ? 1 : 0);
    await page.screenshot({path:info.outputPath("fallback-returned.png"),fullPage:true});
});
