import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const portDefaults = { API: 13100, WEB: 13000, POSTGRES: 15432, REDIS: 16379, S3: 19000, S3_CONSOLE: 19001 };
const osVariables = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TERM", "COLORTERM"]);

export function createProdLikeConfig(argv = [], inherited = process.env, projectRoot = root) {
    const args = new Set(argv);
    for (const arg of args) if (!["--api-only", "--check", "--print-config", "--stop"].includes(arg)) throw new Error(`Unknown prod-like option: ${arg}`);
    if (["--check", "--print-config", "--stop"].filter(arg => args.has(arg)).length > 1) throw new Error("Choose only one of --check, --print-config or --stop");
    const ports = Object.fromEntries(Object.entries(portDefaults).map(([key, fallback]) => {
        const port = Number(inherited[`PRODLIKE_${key}_PORT`] || fallback);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`PRODLIKE_${key}_PORT must be an integer from 1024 to 65535`);
        return [key, port];
    }));
    if (new Set(Object.values(ports)).size !== Object.keys(ports).length) throw new Error("All prod-like ports must be different");
    // In particular: never inherit DATABASE_URL, real provider keys, NODE_OPTIONS,
    // proxies, DOCKER_HOST/CONTEXT, COMPOSE_FILE, BUN_OPTIONS or VITE_* values.
    const systemEnv = Object.fromEntries(Object.entries(inherited).filter(([key, value]) => osVariables.has(key.toUpperCase()) && typeof value === "string"));
    const temporary = resolve(projectRoot, "output/prod-like/tmp");
    const portEnv = Object.fromEntries(Object.entries(ports).map(([key, value]) => [`PRODLIKE_${key}_PORT`, String(value)]));
    const appEnv = {
        ...systemEnv, ...portEnv, TMPDIR: temporary, TEMP: temporary, TMP: temporary,
        NODE_ENV: "development", CANVAS_PRODLIKE: "true", HOST: "127.0.0.1", PORT: String(ports.API),
        DATABASE_URL: `postgres://canvas_prodlike:prodlike-postgres-only@127.0.0.1:${ports.POSTGRES}/canvas_prodlike`,
        REDIS_URL: `redis://127.0.0.1:${ports.REDIS}/0`,
        S3_ENDPOINT: `http://127.0.0.1:${ports.S3}`, S3_PUBLIC_ENDPOINT: `http://127.0.0.1:${ports.S3}`,
        S3_REGION: "us-east-1", S3_BUCKET: "canvas-prodlike", S3_ACCESS_KEY_ID: "canvas-prodlike",
        S3_SECRET_ACCESS_KEY: "prodlike-minio-only", S3_FORCE_PATH_STYLE: "true",
        AUTH_ENABLED: "true", OA_LOGIN_ENABLED: "false", CREDITS_ENABLED: "false", ROLE_PORTALS_ENABLED: "true",
        TRUST_PROXY: "false", SESSION_COOKIE_NAME: "canvas_prodlike_session", SESSION_TTL_SECONDS: "28800",
        BOOTSTRAP_ADMIN_USERNAME: "prodlike-admin", BOOTSTRAP_ADMIN_DISPLAY_NAME: "本地正式栈测试管理员",
        BOOTSTRAP_ADMIN_PASSWORD: "Prodlike-Admin-Only-2026!",
        PROVIDER_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString("base64"),
        TASK_MOCK_MODE: "true", WORKER_CONCURRENCY: "2", WORKER_SHUTDOWN_GRACE_SECONDS: "5",
        VITE_STANDALONE_EDITION: "false", VITE_API_PROXY_TARGET: `http://127.0.0.1:${ports.API}`,
    };
    return {
        root: projectRoot, project: "canvas-prodlike", ports, temporary,
        apiOnly: args.has("--api-only"), mode: args.has("--check") ? "check" : args.has("--print-config") ? "print" : args.has("--stop") ? "stop" : "start",
        appEnv, dockerEnv: { ...systemEnv, ...portEnv, COMPOSE_DISABLE_ENV_FILE: "1" },
        composeArgs: ["compose", "--project-name", "canvas-prodlike", "--project-directory", projectRoot,
            "--env-file", resolve(projectRoot, "tools/dev-prod-like.env"), "--file", resolve(projectRoot, "docker-compose.dev.yml")],
    };
}

export function prodLikeSummary(config) {
    return {
        mode: "isolated-local-formal-backend", project: config.project,
        api: `http://127.0.0.1:${config.ports.API}`, web: config.apiOnly ? null : `http://127.0.0.1:${config.ports.WEB}`,
        ports: config.ports, database: "canvas_prodlike", bucket: "canvas-prodlike", taskMockMode: true,
        entrypoints: ["server/src/index.ts", "server/src/worker.ts"], loadsApplicationEnvFiles: false,
        limitations: ["Image tasks use mock SVG results; no paid model is called by the Worker.",
            "Video/audio mock tasks are rejected; chat and prompt optimization are not mocked.",
            "Vite is the local proxy; this is not a test of either production Nginx layer."],
    };
}

export function assertLocalDockerEndpoint(endpoint) {
    if (typeof endpoint !== "string" || !(/^(unix:\/\/\/|npipe:\/\/\/\/\.\/pipe\/)/.test(endpoint))) {
        throw new Error("Prod-like refuses remote Docker endpoints. Select a local unix-socket/named-pipe Docker context first.");
    }
}

export function assertProdLikeDatabase(env) {
    let url;
    try { url = new URL(env.DATABASE_URL); } catch { throw new Error("Invalid isolated prod-like database URL"); }
    if (env.CANVAS_PRODLIKE !== "true" || env.TASK_MOCK_MODE !== "true" || url.protocol !== "postgres:"
        || url.hostname !== "127.0.0.1" || url.username !== "canvas_prodlike" || url.password !== "prodlike-postgres-only"
        || url.pathname !== "/canvas_prodlike" || url.search || url.hash) throw new Error("Refusing to initialize a non-prod-like database");
}

export async function checkPort(port) {
    const server = createServer();
    await new Promise((done, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", done); });
    await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
}

/** One owner for every process created here; never kill by executable name or port. */
function processRunner() {
    const children = new Set();
    let stopping = false;
    const stop = (code = 0) => {
        if (stopping) return;
        stopping = true;
        process.exitCode = code;
        for (const child of children) {
            if (child.exitCode !== null || !child.pid) continue;
            if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
            else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }
        }
    };
    const spawnOwned = (command, args, options) => {
        if (stopping) throw new Error("Prod-like startup was stopped");
        const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: true, detached: process.platform !== "win32" });
        children.add(child);
        child.once("close", () => children.delete(child));
        return child;
    };
    return {
        stop,
        get stopping() { return stopping; },
        async run(command, args, options) {
            const child = spawnOwned(command, args, options);
            let output = "", errors = "";
            child.stdout?.on("data", chunk => { output = (output + chunk.toString()).slice(-1_000_000); });
            child.stderr?.on("data", chunk => { errors = (errors + chunk.toString()).slice(-16_000); });
            return new Promise((done, fail) => {
                child.once("error", error => fail(new Error(`${command}: ${error.code === "ENOENT" ? "not installed or not on PATH" : error.message}`)));
                child.once("close", code => code === 0 ? done(output.trim()) : fail(new Error(`${command} exited ${code ?? "by signal"}${errors ? `: ${errors.trim()}` : ""}`)));
            });
        },
        launch(command, args, options) {
            const child = spawnOwned(command, args, options);
            child.once("error", error => { console.error(`${options.name}: ${error.message}`); stop(1); });
            child.once("exit", code => { if (!stopping) { console.error(`${options.name} stopped (${code ?? "signal"}); stopping this launcher's processes.`); stop(code || 1); } });
            return child;
        },
    };
}

export async function inspectProdLikeDocker(config, run) {
    const options = { cwd: config.root, env: config.dockerEnv, capture: true };
    const context = (await run("docker", ["context", "show"], options)).trim();
    if (!context || /\s/.test(context)) throw new Error("Docker did not report a valid active context");
    const endpoint = JSON.parse(await run("docker", ["context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}"], options));
    assertLocalDockerEndpoint(endpoint);
    const prefix = ["--context", context];
    const os = await run("docker", [...prefix, "info", "--format", "{{.OSType}}"], options);
    if (os.trim() !== "linux") throw new Error("Prod-like requires a running Linux-container Docker engine");
    const help = await run("docker", [...prefix, "compose", "up", "--help"], options);
    if (!help.includes("--wait-timeout")) throw new Error("Docker Compose with up --wait and --wait-timeout is required; update Compose first");
    await run("docker", [...prefix, ...config.composeArgs, "config", "--quiet"], options);
    return prefix;
}

export async function prepareProdLike(config, runner, { portCheck = checkPort, inspectDocker = inspectProdLikeDocker } = {}) {
    const prefix = await inspectDocker(config, runner.run.bind(runner));
    const docker = (args, capture = false) => runner.run("docker", [...prefix, ...config.composeArgs, ...args], { cwd: config.root, env: config.dockerEnv, capture });
    if (config.mode === "stop") { await docker(["stop", "postgres", "redis", "minio"]); return false; }
    await portCheck(config.ports.API);
    if (!config.apiOnly) await portCheck(config.ports.WEB);
    for (const file of ["server/node_modules/pg/package.json", "server/node_modules/redis/package.json", ...(!config.apiOnly ? ["web/node_modules/vite/package.json", "web/node_modules/@vitejs/plugin-react/package.json"] : [])]) {
        if (!existsSync(resolve(config.root, file))) throw new Error(`Missing ${file}; install the repository's locked dependencies first`);
    }
    if (config.mode === "check") return false;
    mkdirSync(config.temporary, { recursive: true });
    await docker(["up", "-d", "--build", "--wait", "--wait-timeout", "120", "postgres", "redis", "minio"]);
    await docker(["run", "--rm", "--no-deps", "minio-init"]);
    for (const script of ["server/src/migrate.ts", "server/src/bootstrap.ts", "tools/dev-prod-like-seed.ts"]) {
        await runner.run(process.execPath, ["--no-env-file", script], { cwd: config.root, env: config.appEnv });
    }
    return true;
}

async function waitUntil(check, label, runner, timeout = 60_000) {
    const deadline = Date.now() + timeout;
    while (!runner.stopping && Date.now() < deadline) {
        try { if (await check()) return; } catch { /* Dependencies may still be starting. */ }
        await new Promise(done => setTimeout(done, 1000));
    }
    throw new Error(`${label} did not become ready; inspect the preceding process logs`);
}

export async function main(argv = process.argv.slice(2)) {
    const config = createProdLikeConfig(argv);
    if (config.mode === "print") { console.log(JSON.stringify(prodLikeSummary(config), null, 2)); return; }
    if (!process.versions.bun) throw new Error("Use Bun to launch the formal API and Worker: bun --no-env-file tools/dev-prod-like.mjs");
    const runner = processRunner();
    const interrupt = () => runner.stop();
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
        if (!await prepareProdLike(config, runner)) {
            console.log(config.mode === "stop" ? "Stopped only canvas-prodlike dependencies. All data volumes were retained." : "Prod-like preflight passed. No containers, migrations or application processes were started.");
            return;
        }
        for (const [name, script] of [["Formal API", "server/src/index.ts"], ["Formal Worker", "server/src/worker.ts"]]) {
            runner.launch(process.execPath, ["--no-env-file", "--watch", script], { cwd: config.root, env: config.appEnv, name });
        }
        await waitUntil(async () => (await fetch(`http://127.0.0.1:${config.ports.API}/api/health`, { signal: AbortSignal.timeout(2000) })).ok, "Formal API", runner);
        await waitUntil(async () => {
            await runner.run(process.execPath, ["--no-env-file", "server/src/worker-healthcheck.ts"], { cwd: config.root, env: config.appEnv, capture: true });
            return true;
        }, "Formal Worker heartbeat", runner);
        if (!config.apiOnly) runner.launch(process.execPath, ["--no-env-file", "tools/dev-prod-like-vite.mjs"], { cwd: config.root, env: config.appEnv, name: "Vite" });
        const summary = prodLikeSummary(config);
        console.log(`Prod-like formal API ready: ${summary.api}; ${summary.web ? `Vite: ${summary.web}` : "API + Worker only"}`);
        console.log("TEST ONLY: TASK_MOCK_MODE=true. Worker image tasks produce mock SVGs; video/audio are rejected; chat/prompt optimization are NOT mocked.");
        console.log("Use only these isolated test accounts; do not import production data or provider keys.");
        console.log("Initial logins (first login requires password change): prodlike-admin / Prodlike-Admin-Only-2026!; prodlike-designer / Prodlike-Designer-Only-2026!");
        console.log("Ctrl+C stops this launcher's API/Worker/Vite only. Dependencies/data remain. Use bun run dev:prod-like --stop to stop its containers without deleting volumes.");
    } catch (error) {
        runner.stop(1);
        throw error;
    } finally {
        if (config.mode !== "start" || runner.stopping) {
            process.removeListener("SIGINT", interrupt);
            process.removeListener("SIGTERM", interrupt);
        }
    }
}

if (import.meta.main) main().catch(error => { console.error(`Prod-like startup failed: ${error.message}`); console.error("No production environment or data is used. Docker/Compose must be installed and running locally; --print-config is available without Docker."); process.exitCode = 1; });
