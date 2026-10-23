import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, basename, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const webDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, cwd) {
    return new Promise((resolveRun, reject) => {
        const child = spawn(process.execPath, command, { cwd, stdio: "inherit", windowsHide: true });
        child.once("error", reject);
        child.once("exit", (code, signal) => code === 0 ? resolveRun() : reject(new Error(`Build step failed (${signal || code}): ${command.join(" ")}`)));
    });
}

function ownedStaging(root, path) {
    const resolved = resolve(path);
    if (dirname(resolved) !== resolve(root) || !basename(resolved).startsWith("dist-build-")) throw new Error("Unexpected build staging directory");
    return resolved;
}

export async function publishDist(root, staging) {
    staging = ownedStaging(root, staging);
    const destination = join(root, "dist");
    const backup = join(root, `dist-backup-${randomUUID()}`);
    if ((await lstat(staging)).isSymbolicLink() || (existsSync(destination) && (await lstat(destination)).isSymbolicLink())) throw new Error("Build directories must not be symbolic links");
    if (!existsSync(join(staging, "index.html"))) throw new Error("Build output is missing index.html");
    let backedUp = false;
    if (existsSync(destination)) {
        await rename(destination, backup);
        backedUp = true;
    }
    try {
        await rename(staging, destination);
    } catch (error) {
        if (backedUp) await rename(backup, destination);
        throw error;
    }
    if (backedUp) {
        // This exact sibling was created by the successful rename above, never a
        // user-selected directory. A cleanup failure must not undo a valid build.
        await rm(backup, { recursive: true, force: true }).catch(() => console.warn(`Previous build retained at ${backup}`));
    }
}

export async function buildWeb(root = webDirectory, runner = run) {
    const staging = await mkdtemp(join(root, "dist-build-"));
    try {
        await runner(["run", "tsc", "--noEmit"], root);
        await runner(["run", "vite", "build", "--outDir", staging], root);
        await runner([join(root, "scripts", "bundle-budget.mjs"), staging], root);
        await publishDist(root, staging);
    } finally {
        await rm(ownedStaging(root, staging), { recursive: true, force: true });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await buildWeb();
}
