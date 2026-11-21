import {expect,test} from "./fixtures";

test("seven actions preserve scoped routes, reopen deep links and send zero generations",async({page,api},info)=>{
    await page.goto("/garment-colorway");
    const nav=page.getByRole("navigation",{name:"主导航"}),color=nav.getByRole("button",{name:"换色",exact:true});
    await expect(color).toHaveAttribute("aria-expanded","true");
    await expect(nav.getByRole("link",{name:"服装配色",exact:true})).toHaveAttribute("aria-current","page");
    await nav.getByRole("button",{name:"改局部",exact:true}).click();await expect(color).toHaveAttribute("aria-expanded","false");
    await nav.getByRole("link",{name:"局部改款",exact:true}).click();await expect(page).toHaveURL(/\/local-restyle$/);
    await expect(nav.getByRole("link",{name:"局部改款",exact:true})).toHaveAttribute("aria-current","page");
    await nav.getByRole("button",{name:"资源库",exact:true}).click();await expect(nav.getByRole("link",{name:"素材库",exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath("seven-action-navigation.png")});
    await page.reload();await expect(nav.getByRole("button",{name:"改局部",exact:true})).toHaveAttribute("aria-expanded","true");
    expect(api.tasks.size).toBe(0);
});
test("disabled workbench keeps the old navigation",async({page,api})=>{
    api.disabledModules.add("canvas-tryout");await page.goto("/garment-colorway");
    const nav=page.getByRole("navigation",{name:"主导航"});
    await expect(nav.getByRole("button",{name:"创作工具",exact:true})).toBeVisible();
    await expect(nav.getByRole("button",{name:"改局部",exact:true})).toHaveCount(0);
});
