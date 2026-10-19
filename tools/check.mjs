import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const [directory, command] of [[".", ["run", "lint"]], ["server", ["run", "build"]], ["web", ["run", "build"]], ["server", ["--no-env-file", "test"]], ["web", ["--no-env-file", "test"]]]) {
    console.log(`Checking ${directory}: bun ${command.join(" ")}`);
    const result = spawnSync(process.execPath, command, { cwd: resolve(root, directory), stdio: "inherit", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
