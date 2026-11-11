import { test, expect } from "./fixtures";
import { seedRetiredRecipes, snapshotRetiredRecipes, expectRecipeRetired } from "./retired-recipe-fixtures";

test("retired series recipe retains frozen candidates, original bytes and task tabs through reload", async ({ page, api }) => {
    const before = await seedRetiredRecipes(page, 2);
    await page.goto("/creative/series-recipe");
    await expectRecipeRetired(page);
    expect(await snapshotRetiredRecipes(page)).toEqual(before);
    await page.reload();
    await expectRecipeRetired(page);
    expect(await snapshotRetiredRecipes(page)).toEqual(before);
    expect(api.submissions).toEqual([]);
    expect(api.batchSubmissions).toEqual([]);
    expect(api.taskReads).toEqual([]);
});

test("retired series recipe never resumes or reposts accepted pending branches from a saved URL", async ({ page, context, api }) => {
    const before = await seedRetiredRecipes(page, 1, true);
    const writes: string[] = [];
    context.on("request", request => {
        if (new URL(request.url()).pathname.startsWith("/api/tasks") && request.method() !== "GET") writes.push(request.url());
    });
    await page.goto("/creative/series-recipe?task=default#saved-project");
    await expectRecipeRetired(page);
    await page.reload();
    await expectRecipeRetired(page);
    expect(await snapshotRetiredRecipes(page)).toEqual(before);
    expect(api.taskReads).toEqual([]);
    expect(writes).toEqual([]);
    expect(api.submissions).toEqual([]);
});
