import { test, expect } from "./fixtures";
import { seedRetiredRecipes, snapshotRetiredRecipes, expectRecipeRetired } from "./retired-recipe-fixtures";

for (const mode of ["fail", "hold"] as const) {
    test(`retirement does not open or overwrite old recipe storage when original reads would ${mode}`, async ({ page, api }) => {
        const before = await seedRetiredRecipes(page, 1, true);
        await page.addInitScript(mode => {
            const get = IDBObjectStore.prototype.get, put = IDBObjectStore.prototype.put;
            const gate = (window as any).__retiredRecipeGate = { enabled: true, reads: 0, writes: 0 };
            IDBObjectStore.prototype.get = function (...args) {
                if (gate.enabled && this.name === "series_recipe_workspaces") {
                    gate.reads++;
                    if (mode === "fail") throw new Error("retired-recipe-must-not-be-read");
                    const request = get.apply(this, args);
                    Object.defineProperty(request, "onsuccess", { set() {} });
                    return request;
                }
                return get.apply(this, args);
            };
            IDBObjectStore.prototype.put = function (...args) {
                if (gate.enabled && this.name === "series_recipe_workspaces") gate.writes++;
                return put.apply(this, args);
            };
        }, mode);
        await page.goto("/creative/series-recipe");
        await expectRecipeRetired(page);
        expect(await page.evaluate(() => {
            const gate = (window as any).__retiredRecipeGate;
            gate.enabled = false;
            return { reads: gate.reads, writes: gate.writes };
        })).toEqual({ reads: 0, writes: 0 });
        expect(await snapshotRetiredRecipes(page)).toEqual(before);
        expect(api.submissions).toEqual([]);
        expect(api.taskReads).toEqual([]);
    });
}
