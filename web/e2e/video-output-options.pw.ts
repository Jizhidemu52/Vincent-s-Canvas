import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixtures";
import { toolDefinitions } from "../../shared/feature-catalog";
import { preflightVideoTask } from "../../server/src/video-task-preflight";
import { runApiMartVideoTask } from "../../server/src/media-runtime";

const videoPath = fileURLToPath(new URL("./media/video.mp4", import.meta.url));
const playback = readFileSync(videoPath);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

for (const parameterModelId of ["happyhorse-1.1", "doubao-seedance-2.5"] as const) {
    test(`真实视频参数→请求→历史恢复与原件下载：${parameterModelId}`, async ({ page, context, api }, info) => {
        const seedance = parameterModelId === "doubao-seedance-2.5";
        const seed = seedance ? "-1" : "2147483647";
        const format = seedance ? "mov" : "mp4";
        const model = { id: "10000000-0000-4000-8000-000000000003", modelId: "10000000-0000-4000-8000-000000000003", parameterModelId, name: parameterModelId, capabilities: ["video"], creditCost: 0, rmbCost: 0 };
        const resultId = "80000000-0000-4000-8000-000000000099";
        const originalPath = info.outputPath(`original.${format}`);
        const original = seedance ? (() => {
            execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-i", videoPath, "-c", "copy", "-f", "mov", originalPath], { windowsHide: true, timeout: 30_000 });
            return readFileSync(originalPath);
        })() : playback;
        const providerBodies: Record<string, unknown>[] = [];
        let preflights = 0;
        await context.route("**/api/models", route => route.fulfill({ json: { models: [model], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: model.id, configurationVersion: 1 })), prices: [] } }));
        await context.route("**/api/tasks/preflight", route => {
            preflights++;
            const input = route.request().postDataJSON();
            const checked = preflightVideoTask({ model: parameterModelId, prompt: input.prompt, parameters: input.parameters });
            return route.fulfill({ json: { ok: true, normalized: checked.normalized } });
        });
        await context.route("**/api/tasks", async route => {
            if (route.request().method() !== "POST") return route.fallback();
            const input = route.request().postDataJSON();
            api.submissions.push(input);
            await runApiMartVideoTask({ baseUrl: "https://isolated-provider.invalid/v1", apiKey: "fixture-only", modelId: parameterModelId, prompt: input.prompt, parameters: input.parameters, sources: [], beforeSubmit: async () => true, onSubmitted: async () => undefined }, {
                sleep: async () => undefined,
                fetch: async (_url, init) => {
                    if (init?.method === "POST") { providerBodies.push(JSON.parse(String(init.body))); return Response.json({ data: [{ task_id: "fixture-output-options" }] }); }
                    return Response.json({ data: { status: "completed", result: { videos: [`https://fixture-cdn.invalid/result.${format}`] } } });
                },
            });
            const task = { ...input, id: resultId, status: "success", resultUrls: [`/api/assets/${resultId}/content`], createdAt: new Date().toISOString() };
            api.tasks.set(resultId, task);
            return route.fulfill({ status: 201, json: { task } });
        });
        await context.route(`**/api/assets/${resultId}/content`, route => route.fulfill({ contentType: seedance ? "video/quicktime" : "video/mp4", body: original }));
        await context.route(`**/api/assets/${resultId}/playback`, route => route.fulfill({ contentType: "video/mp4", body: playback }));
        await page.goto("/video");
        const title = "种子输出链路验证";
        const prompt = page.getByRole("textbox", { name: "视频提示词", exact: true });
        await prompt.fill(title);
        await page.getByRole("button", { name: /^调\s*整$/ }).click();
        const settings = page.getByRole("dialog", { name: "参数", exact: true });
        const seedInput = settings.getByRole("textbox", { name: "视频随机种子", exact: true });
        await seedInput.fill(seed);
        const output = settings.getByRole("combobox", { name: "视频输出格式", exact: true });
        if (seedance) {
            await output.click();
            await page.locator(".ant-select-dropdown:visible").getByText("MOV", { exact: true }).click();
        } else await expect(output).toHaveCount(0);
        await settings.getByRole("button", { name: "关闭", exact: true }).click();
        expect(api.submissions).toHaveLength(0);
        await page.getByRole("button", { name: "生成视频", exact: true }).click();
        await expect.poll(() => api.submissions.length).toBe(1);
        await expect(page.locator("video")).toHaveCount(1);
        await expect.poll(() => page.locator("video").evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
        expect(preflights).toBe(1);
        expect(api.submissions[0].parameters.seed).toBe(Number(seed));
        expect(providerBodies).toHaveLength(1);
        expect(providerBodies[0].seed).toBe(Number(seed));
        if (seedance) {
            expect(api.submissions[0].parameters.outputFormat).toBe("mov");
            expect(providerBodies[0].output_format).toBe("mov");
        } else {
            expect(api.submissions[0].parameters).not.toHaveProperty("outputFormat");
            expect(providerBodies[0]).not.toHaveProperty("output_format");
        }

        // A reload uses the persisted generation record. Overwrite the live draft
        // first so restoring the seed and format cannot pass by retaining config.
        await page.reload();
        await expect(page.locator("video")).toHaveCount(1);
        await prompt.fill("之后的新草稿");
        await page.getByRole("button", { name: /^调\s*整$/ }).click();
        await seedInput.fill("17");
        if (seedance) {
            await output.click();
            await page.locator(".ant-select-dropdown:visible").getByText("MP4", { exact: true }).click();
        }
        await settings.getByRole("button", { name: "关闭", exact: true }).click();
        await page.getByRole("button").filter({ hasText: title }).click();
        await page.getByRole("button", { name: "恢复为草稿继续改", exact: true }).click();
        await page.getByRole("button", { name: "确认恢复", exact: true }).click();
        await expect(prompt).toHaveValue(title);
        await page.getByRole("button", { name: /^调\s*整$/ }).click();
        await expect(seedInput).toHaveValue(seed);
        if (seedance) {
            const selectedOutput = settings.locator(".ant-select-content").filter({ has: page.getByRole("combobox", { name: "视频输出格式", exact: true }) });
            await expect(selectedOutput).toBeVisible();
            await expect(selectedOutput).toHaveAttribute("title", "MOV");
        }
        await settings.getByRole("button", { name: "关闭", exact: true }).click();
        const download = page.waitForEvent("download");
        await page.getByRole("button", { name: "下载", exact: true }).click();
        const downloaded = await download;
        expect(downloaded.suggestedFilename()).toMatch(new RegExp(`\\.${format}$`));
        await downloaded.saveAs(info.outputPath(`downloaded.${format}`));
        expect(sha(readFileSync(info.outputPath(`downloaded.${format}`)))).toBe(sha(original));
        expect(api.submissions).toHaveLength(1);
        expect(api.pageErrors).toEqual([]);
        await info.attach("request-and-original-evidence", { contentType: "application/json", body: Buffer.from(JSON.stringify({ request: api.submissions[0].parameters, provider: providerBodies[0], originalSha256: sha(original), filename: downloaded.suggestedFilename(), submissions: api.submissions.length })) });
    });
}
