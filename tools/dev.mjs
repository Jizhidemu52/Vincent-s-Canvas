import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
for (const arg of args) if (!["--api-only", "--print-config"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
const apiPort = Number(process.env.DEV_API_PORT || 3100);
const webPort = Number(process.env.DEV_WEB_PORT || 3000);
for (const port of [apiPort, webPort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Development ports must be integers between 1024 and 65535");
if (apiPort === webPort && !args.has("--api-only")) throw new Error("Development API and Vite ports must differ");
const statePath = resolve(root, "server/.data/dev-local.sqlite");
if (args.has("--print-config")) {
    console.log(JSON.stringify({ api: `http://127.0.0.1:${apiPort}`, web: args.has("--api-only") ? null : `http://127.0.0.1:${webPort}`, statePath }));
    process.exit(0);
}
async function checkPort(port) {
    const server = createServer();
    await new Promise((ok, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", ok); });
    await new Promise((ok, fail) => server.close(error => error ? fail(error) : ok()));
}
await checkPort(apiPort);
if (!args.has("--api-only")) await checkPort(webPort);
const children = [];
let stopping = false;
function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
        if (child.exitCode !== null || !child.pid) continue;
        // Only terminate the process trees created by this launcher.
        if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        else child.kill("SIGTERM");
    }
    process.exitCode = code;
}
function launch(name, command, cwd, env) {
    const child = spawn(process.execPath, command, { cwd, env: { ...process.env, ...env }, stdio: "inherit", windowsHide: true });
    children.push(child);
    child.once("error", error => { console.error(`${name}: ${error.message}`); stop(1); });
    child.once("exit", code => { if (!stopping) { console.error(`${name} stopped (${code ?? "signal"})`); stop(code ?? 1); } });
}
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
console.log(`Local development API: http://127.0.0.1:${apiPort}; isolated state: ${statePath}`);
console.log("Provider calls still use server/.env and may incur charges. Existing 5188 / LAN services are unchanged.");
const serverEnvFile = resolve(root, "server/.env");
launch("API", [...(existsSync(serverEnvFile) ? [`--env-file=${serverEnvFile}`] : []), "--watch", "server/src/demo-server.ts"], root, { DEMO_HOST: "127.0.0.1", DEMO_PORT: String(apiPort), DEMO_STATE_PATH: statePath, OA_LOGIN_ENABLED: "false", LOCAL_STANDALONE: "false", STANDALONE_WEB_DIR: "" });
if (!args.has("--api-only")) {
    console.log(`Vite: http://127.0.0.1:${webPort}`);
    launch("Vite", ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], resolve(root, "web"), { VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` });
}
