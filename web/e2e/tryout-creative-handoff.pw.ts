import {expect,test} from "./fixtures";

for(const entry of ["/garment-colorway","/creative/virtual-try-on"])test("open tryout from "+entry+" without creating a task or changing the old draft",async({page,api},info)=>{
    await page.goto(entry);
    const link=page.getByRole("link",{name:"在画布里试款"});
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByText("选择或新建画布，打开试款台。此操作不会生成图片。")).toBeVisible();
    const create=(entry.startsWith("/creative/")?page.getByRole("main"):page).getByRole("button",{name:"新建画布",exact:true}).first();
    await create.click();
    await expect(page.getByRole("region",{name:"企划色板"})).toBeVisible();
    await expect(page).toHaveURL(/\/canvas\/[^/?]+$/);
    expect(api.tasks.size).toBe(0);
    await page.screenshot({path:info.outputPath("creative-tryout.png")});
    await page.getByRole("button",{name:"试款台",exact:true}).click();
    await page.reload();
    await expect(page.getByRole("button",{name:"试款台",exact:true})).toBeVisible();
    await expect(page.getByRole("region",{name:"企划色板"})).toHaveCount(0);
    expect(api.tasks.size).toBe(0);
});
test("old scene remains accessible with tryout disabled",async({page,api})=>{
    api.disabledModules.add("canvas-tryout");
    await page.goto("/garment-colorway");
    await expect(page.getByRole("button",{name:"清空当前草稿"})).toBeVisible();
    await expect(page.getByRole("link",{name:"在画布里试款"})).toHaveCount(0);
});
