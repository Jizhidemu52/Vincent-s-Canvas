import {expect,test} from "./fixtures";

test("desktop lists permitted project entries directly without an accordion hiding its siblings",async({page,api},info)=>{
    await page.goto("/garment-colorway");
    const nav=page.getByRole("navigation",{name:"主导航"});
    for(const group of ["创作工具","图像工具","资源库"])await expect(nav.getByRole("button",{name:group,exact:true})).toHaveAttribute("aria-expanded","true");
    await expect(nav.getByRole("link",{name:"服装配色",exact:true})).toHaveAttribute("aria-current","page");
    await nav.getByRole("link",{name:"局部改款",exact:true}).click();await expect(page).toHaveURL(/\/local-restyle$/);
    await expect(nav.getByRole("link",{name:"局部改款",exact:true})).toHaveAttribute("aria-current","page");
    for(const name of ["素材库","高清放大","视频生成","我的提示词"])await expect(nav.getByRole("link",{name,exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath("expanded-navigation.png")});
    await page.reload();await expect(nav.getByRole("link",{name:"服装配色",exact:true})).toBeVisible();
    expect(api.tasks.size).toBe(0);
});
test("disabled workbench keeps the old navigation",async({page,api})=>{
    api.disabledModules.add("canvas-tryout");await page.goto("/garment-colorway");
    const nav=page.getByRole("navigation",{name:"主导航"});
    await expect(nav.getByRole("button",{name:"创作工具",exact:true})).toBeVisible();
    await expect(nav.getByRole("button",{name:"改局部",exact:true})).toHaveCount(0);
});
