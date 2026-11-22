import { expect, newCanvas, test, uploadImage, IMAGE } from "./fixtures";

test("command search opens the tryout panel using its product-language aliases",async({page,api})=>{
    await newCanvas(page);
    await page.keyboard.press("Control+k");
    const query=page.getByRole("combobox",{name:"搜索命令、节点和素材"});
    await query.fill("试材质");
    await page.getByRole("option",{name:"试色",exact:true}).click();
    await expect(page.getByTestId("canvas-design-toolbox")).toBeVisible();
    expect(api.submissions).toHaveLength(0);
});

test("disabled tryout keeps the old quick actions and ignores the shortcut", async ({page,api})=>{
    api.disabledModules.add("canvas-tryout");
    await newCanvas(page);
    await expect(page.getByRole("button",{name:"试款台",exact:true})).toHaveCount(0);
    await page.keyboard.press("t");
    await uploadImage(page);
    await expect(page.getByRole("complementary",{name:"图片快捷处理"})).toBeVisible();
    await expect(page.getByTestId("canvas-design-toolbox")).toHaveCount(0);
    expect(api.submissions).toHaveLength(0);
});

for (const width of [1350,390]) test(`toolbox and discussion keep an unsent draft when switching tabs at ${width}px`, async ({page,api},info)=>{
    await page.setViewportSize({width,height:880});
    await newCanvas(page);
    const toolbox=page.getByRole("complementary",{name:"设计工具箱"});
    const entry=page.getByRole("button",{name:"试款台",exact:true});
    await expect(entry).toHaveAttribute("aria-expanded","false");
    await entry.click();
    await toolbox.getByRole("button",{name:"设计讨论",exact:true}).click();
    const composer=page.getByRole("textbox",{name:"输入设计需求",exact:true});
    await composer.fill("保留肩线，暂不生成");
    await composer.press("End");
    await composer.press("t");
    await expect(entry).toHaveAttribute("aria-expanded","true");
    await toolbox.getByRole("button",{name:"工具箱",exact:true}).click();
    await expect(composer).toBeHidden();
    await toolbox.getByRole("button",{name:"设计讨论",exact:true}).click();
    await expect(composer).toHaveValue("保留肩线，暂不生成t");
    await page.screenshot({path:info.outputPath("discussion-toolbox-tabs.png")});
    expect(api.submissions).toHaveLength(0);
});

test("the right toolbox makes a board from three real canvas images and keeps original references across reload without generating", async ({page,api},info)=>{
    const id=await newCanvas(page);
    const toolbox=page.getByRole("complementary",{name:"设计工具箱"});
    const entry=page.getByRole("button",{name:"试款台",exact:true});
    await expect(entry).toHaveAttribute("aria-expanded","false");
    await page.keyboard.press("t");
    await expect(toolbox).toContainText("选中图片后可用");
    await expect(toolbox.getByRole("button",{name:"出提案板"})).toBeDisabled();
    const chooser=page.waitForEvent("filechooser");
    await page.getByRole("button",{name:"上传素材",exact:true}).click();
    await(await chooser).setFiles(["正面","侧面","背面"].map(name=>({name:name+".png",mimeType:"image/png",buffer:IMAGE})));
    await expect.poll(()=>api.document(id)?.nodes.length).toBe(3);
    const originals=api.document(id)!.nodes.map((n:any)=>({id:n.id,content:n.metadata.content}));
    await page.keyboard.press("Control+a");
    await toolbox.getByRole("button",{name:"出提案板"}).click();
    await expect.poll(()=>api.document(id)?.nodes.length).toBe(4);
    const board=api.document(id)!.nodes.find((n:any)=>n.metadata?.proposalBoard);
    expect(board.type).toBe("image");
    expect(board.metadata.proposalBoard.layout).toBe("feature");
    expect(board.metadata.proposalBoard.items.map((i:any)=>i.nodeId).sort()).toEqual(originals.map((i:any)=>i.id).sort());
    for(const ref of board.metadata.proposalBoard.items) expect(ref.content).toBe(originals.find((n:any)=>n.id===ref.nodeId)?.content);
    expect(board.metadata.naturalWidth).toBe(1754);
    expect(board.metadata.naturalHeight).toBe(1240);
    expect(api.document(id)!.nodes.slice(0,3).map((n:any)=>({id:n.id,content:n.metadata.content}))).toEqual(originals);
    await page.reload();
    await expect(entry).toHaveAttribute("aria-expanded","true");
    await toolbox.getByRole("button",{name:"收起试款台"}).click();
    await page.reload();
    await expect(entry).toHaveAttribute("aria-expanded","false");
    await entry.click();
    await expect(page.locator(`[data-node-id="${board.id}"]`).first()).toBeVisible();
    await page.screenshot({path:info.outputPath("canvas-proposal-board.png")});
    expect(api.submissions).toHaveLength(0);
    expect(api.batchSubmissions).toHaveLength(0);
});
