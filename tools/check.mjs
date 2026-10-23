import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const missing = ["PGLITE_RUNTIME_PATH", "QUEUE_TEST_REDIS_URL", "RUN_INTEGRATION_TESTS"].filter(key => !process.env[key] || key.startsWith("RUN_") && process.env[key] !== "true");
if (missing.length) console.warn(`Integration coverage is partial. Not configured: ${missing.join(", ")}. Skipped cases are counted below; this is not production backend verification.`);
let totalSkipped = 0;
for (const [directory, command] of [[".", ["run", "lint"]], ["server", ["run", "build"]], ["web", ["run", "build"]], ["server", ["--no-env-file", "test"]], ["web", ["--no-env-file", "test"]]]) {
    console.log(`Checking ${directory}: bun ${command.join(" ")}`);
    let output = "";
    const status = await new Promise((done, reject) => {
        const child = spawn(process.execPath, command, { cwd: resolve(root, directory), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) stream.on("data", chunk => { output = (output + chunk.toString()).slice(-64_000); target.write(chunk); });
        child.once("error", reject); child.once("close", done);
    });
    if (command.includes("test")) {
        const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
        const skipped = Number([...clean.matchAll(/^\s*(\d+)\s+skip\s*$/gm)].at(-1)?.[1] ?? 0);
        totalSkipped += skipped;
        console.log(`${directory}: ${skipped} skipped test cases (Bun test summary).`);
    }
    if (status !== 0) process.exit(status ?? 1);
}
console.log(`Checks passed; skipped test cases: ${totalSkipped}. ${totalSkipped ? "Integration prerequisites are required to exercise skipped coverage." : "No cases skipped by these suites."}`);
