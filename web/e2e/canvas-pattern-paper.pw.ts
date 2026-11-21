import {expect,newCanvas,test} from "./fixtures";

test("pattern paper follows viewport zoom, survives a reload and leaves existing backgrounds available",async({page,api},info)=>{
    const id=await newCanvas(page);
    const select=async(label:string)=>{
        await page.keyboard.press("Control+k");
        const search=page.getByRole("combobox",{name:"搜索命令、节点和素材"});
        await search.fill("画布背景："+label);await search.press("Enter");
    };
    await select("打版纸");
    const tile=page.locator('[data-grid-mode="paper"]');
    await expect(tile).toBeVisible();await expect.poll(()=>api.document(id)?.backgroundMode).toBe("paper");
    const size=await tile.evaluate(el=>getComputedStyle(el).backgroundSize);
    await page.getByRole("button",{name:"放大画布",exact:true}).click();
    await expect.poll(()=>tile.evaluate(el=>getComputedStyle(el).backgroundSize)).not.toBe(size);
    await page.reload();await expect(tile).toBeVisible();
    expect(await tile.evaluate(el=>getComputedStyle(el).backgroundImage)).not.toBe("none");
    await page.screenshot({path:info.outputPath("pattern-paper.png")});
    await select("纯色");await expect(tile).toHaveCount(0);
    await select("点阵");await expect(page.locator('[data-grid-mode="dots"]')).toBeVisible();
    await select("网格");await expect(page.locator('[data-grid-mode="lines"]')).toBeVisible();
    expect(api.tasks.size).toBe(0);
});
