import type { Page } from "@playwright/test";
import { expect, fixturePng } from "./fixtures";

export const RECIPE_OWNER = "00000000-0000-4000-8000-000000000099";

/** Synthetic pre-retirement records. Never mount the removed editor to prepare them. */
export async function seedRetiredRecipes(page: Page, count = 1, pending = false) {
    await page.goto("/image");
    await expect(page.getByRole("textbox", { name: "图像提示词", exact: true })).toBeVisible();
    await page.evaluate(async ({ owner, sources, pending }) => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const { createRecipeForm, createRecipeRun, recipeSettings } = await import("/src/pages/design-workbench/recipe-model.ts");
        const projects = createWorkspaceStorage("series_recipe_workspaces");
        const files = createWorkspaceStorage("image_files");
        const tasks = sources.map((_, index) => ({ id: index ? `retired-${index}` : "default", number: index + 1, createdAt: index }));
        for (const [index, { bytes, dataUrl }] of sources.entries()) {
            const storageKey = `image:retired-recipe-${index}`;
            const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
            await files.setItem(storageKey, blob);
            const form = { ...createRecipeForm(), series: `ARCHIVED_RECIPE_${index}`, count: 6 };
            const references = [{ id: `source-${index}`, name: `original-${index}.png`, type: "image/png", dataUrl, storageKey, originalFileName: `original-${index}.png`, imageName: "原底图", imageVersion: 2 }];
            const run = createRecipeRun(owner, form, references, {}, index % 6);
            Object.assign(run.branches[0], { status: pending ? "running" : "success", attempts: 1, requestId: `archived-request-${index}`, taskIds: [`archived-task-${index}`], submissionStarted: true, images: pending ? [] : references });
            const project = { version: 1, kind: "series-recipe", ownerId: owner, form, references, settings: recipeSettings({}), run, history: [], selectedColor: index % 6 };
            await projects.setItem(`project:${owner}${index ? `:task:retired-${index}` : ""}`, project);
        }
        await createWorkspaceStorage("generation_workbench_tasks").setItem(JSON.stringify([owner, "series-recipe"]), { version: 1, tasks, activeId: tasks.at(-1)!.id, nextNumber: tasks.length + 1 });
    }, { owner: RECIPE_OWNER, sources: Array.from({ length: count }, (_, index) => {
        const bytes = fixturePng(40 + index);
        return { bytes: [...bytes], dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
    }), pending });
    return snapshotRetiredRecipes(page);
}

export async function snapshotRetiredRecipes(page: Page) {
    return page.evaluate(async owner => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const projects: Array<[string, unknown]> = [];
        const files: Array<[string, number[]]> = [];
        await createWorkspaceStorage("series_recipe_workspaces").iterate((value, key) => { projects.push([key, value]); });
        const blobs: Array<[string, Blob]> = [];
        await createWorkspaceStorage("image_files").iterate<Blob, void>((value, key) => { if (key.startsWith("image:retired-recipe-")) blobs.push([key, value]); });
        for (const [key, blob] of blobs) files.push([key, [...new Uint8Array(await blob.arrayBuffer())]]);
        return { projects: projects.sort(([a], [b]) => a.localeCompare(b)), files: files.sort(([a], [b]) => a.localeCompare(b)), registry: await createWorkspaceStorage("generation_workbench_tasks").getItem(JSON.stringify([owner, "series-recipe"])) };
    }, RECIPE_OWNER);
}

export async function expectRecipeRetired(page: Page) {
    await expect(page.getByRole("heading", { name: "系列配方已下线", exact: true })).toBeVisible();
    await expect(page.locator("main input[type=file], main textarea")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /生成第.*色|保存项目|查询原任务|新建任务/ })).toHaveCount(0);
}
