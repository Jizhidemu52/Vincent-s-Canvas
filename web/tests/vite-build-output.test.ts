import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWeb } from "../scripts/build.mjs";

import viteConfig from "../vite.config";

test("cleans only staging while producing a deployment build", () => {
    const config = viteConfig({ command: "build", mode: "production", isSsrBuild: false, isPreview: false });
    expect(config.build?.emptyOutDir).toBe(true);
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts.build).toBe("bun scripts/build.mjs");
    expect(packageJson.scripts.build).not.toContain("clean:dist");
});

test.each([1, 2, 3])("failure in build step %i leaves the serving dist untouched", async failedStep => {
    const root = await mkdtemp(join(tmpdir(), "canvas-build-test-"));
    try {
        await mkdir(join(root, "dist"));
        await writeFile(join(root, "dist", "index.html"), "original live page");
        let step = 0;
        await expect(buildWeb(root, async (command: string[]) => {
            step++;
            if (step === failedStep) throw new Error("fixture build failure");
            if (step === 2) await writeFile(join(command.at(-1)!, "index.html"), "new page");
        })).rejects.toThrow("fixture build failure");
        expect(await readFile(join(root, "dist", "index.html"), "utf8")).toBe("original live page");
        expect(await readdir(root)).toEqual(["dist"]);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("a validated build replaces the old artifact set and removes only its own staging/backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "canvas-build-test-"));
    try {
        await mkdir(join(root, "dist"));
        await writeFile(join(root, "dist", "index.html"), "old page");
        await writeFile(join(root, "dist", "old-hash.js"), "old chunk");
        await writeFile(join(root, "keep.txt"), "unrelated");
        const steps: string[][] = [];
        await buildWeb(root, async (command: string[]) => {
            steps.push(command);
            expect(await readFile(join(root, "dist", "index.html"), "utf8")).toBe("old page");
            if (steps.length === 2) await writeFile(join(command.at(-1)!, "index.html"), "new page");
        });
        expect(steps).toHaveLength(3);
        expect(await readFile(join(root, "dist", "index.html"), "utf8")).toBe("new page");
        expect(await readdir(join(root, "dist"))).toEqual(["index.html"]);
        expect((await readdir(root)).sort()).toEqual(["dist", "keep.txt"]);
    } finally { await rm(root, { recursive: true, force: true }); }
});
