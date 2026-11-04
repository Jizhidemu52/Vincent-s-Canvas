import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { assertLocalDockerEndpoint, assertProdLikeDatabase, checkPort, createProdLikeConfig, inspectProdLikeDocker, prepareProdLike, prodLikeSummary } from "../dev-prod-like.mjs";
import { prodLikeViteOptions } from "../dev-prod-like-vite.mjs";

const root = resolve(import.meta.dir, "../..");

test("prod-like replaces application credentials/URLs and strips process injection, provider and Docker environment", () => {
    const config = createProdLikeConfig([], {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: "postgres://production.invalid/main",
        REDIS_URL: "redis://production.invalid", S3_SECRET_ACCESS_KEY: "real-s3-secret", OPENAI_API_KEY: "real-provider-secret",
        PROVIDER_ENCRYPTION_KEY: "real-provider-encryption", TASK_MOCK_MODE: "false", NODE_OPTIONS: "--require injected.js",
        BUN_OPTIONS: "--preload injected.js", HTTPS_PROXY: "https://proxy.invalid", VITE_PROVIDER_KEY: "real-browser-secret",
        DOCKER_HOST: "ssh://production.invalid", DOCKER_CONTEXT: "production", COMPOSE_FILE: "production.yml", COMPOSE_PROJECT_NAME: "production",
    }, root);
    expect(config.appEnv.DATABASE_URL).toBe("postgres://canvas_prodlike:prodlike-postgres-only@127.0.0.1:15432/canvas_prodlike");
    expect(config.appEnv.HOST).toBe("127.0.0.1");
    expect(config.appEnv.TASK_MOCK_MODE).toBe("true");
    expect(config.appEnv.TMPDIR).toBe(resolve(root, "output/prod-like/tmp"));
    for (const environment of [config.appEnv, config.dockerEnv]) {
        for (const key of ["OPENAI_API_KEY", "NODE_OPTIONS", "BUN_OPTIONS", "HTTPS_PROXY", "VITE_PROVIDER_KEY", "DOCKER_HOST", "DOCKER_CONTEXT", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME"]) expect(environment).not.toHaveProperty(key);
        expect(JSON.stringify(environment)).not.toContain("real-");
        expect(JSON.stringify(environment)).not.toContain("production.invalid");
    }
    expect(config.dockerEnv.COMPOSE_DISABLE_ENV_FILE).toBe("1");
    expect(config.composeArgs).toContain(resolve(root, "tools/dev-prod-like.env"));
    expect(prodLikeSummary(config).entrypoints).toEqual(["server/src/index.ts", "server/src/worker.ts"]);
});

test("port overrides stay isolated and invalid or duplicate ports fail before any process starts", () => {
    const config = createProdLikeConfig(["--api-only"], { PRODLIKE_API_PORT: "23100", PRODLIKE_POSTGRES_PORT: "25432" }, root);
    expect(config.appEnv.PORT).toBe("23100");
    expect(config.appEnv.DATABASE_URL).toContain("127.0.0.1:25432/canvas_prodlike");
    expect(prodLikeSummary(config).web).toBeNull();
    for (const port of ["abc", "1", "65536", "13100.5"]) expect(() => createProdLikeConfig([], { PRODLIKE_API_PORT: port }, root)).toThrow();
    expect(() => createProdLikeConfig([], { PRODLIKE_API_PORT: "13000" }, root)).toThrow("different");
    expect(() => createProdLikeConfig(["--env-file=.env"], {}, root)).toThrow("Unknown");
    expect(() => createProdLikeConfig(["--check", "--stop"], {}, root)).toThrow("Choose only one");
});

test("only explicit local prod-like databases may be seeded", () => {
    const env = createProdLikeConfig([], {}, root).appEnv;
    expect(() => assertProdLikeDatabase(env)).not.toThrow();
    for (const DATABASE_URL of ["postgres://canvas_prodlike:prodlike-postgres-only@production.invalid:15432/canvas_prodlike",
        "postgres://canvas_prodlike:prodlike-postgres-only@127.0.0.1:15432/wireless_canvas",
        "postgres://production:password@127.0.0.1:15432/canvas_prodlike",
        `${env.DATABASE_URL}?host=production.invalid`]) expect(() => assertProdLikeDatabase({ ...env, DATABASE_URL })).toThrow();
    expect(() => assertProdLikeDatabase({ ...env, TASK_MOCK_MODE: "false" })).toThrow();
    expect(() => assertProdLikeDatabase({ ...env, CANVAS_PRODLIKE: undefined })).toThrow();
});

test("Docker remote contexts are refused before engine contact or compose mutation", async () => {
    expect(() => assertLocalDockerEndpoint("unix:///var/run/docker.sock")).not.toThrow();
    expect(() => assertLocalDockerEndpoint("npipe:////./pipe/dockerDesktopLinuxEngine")).not.toThrow();
    for (const endpoint of ["ssh://server", "tcp://127.0.0.1:2375", "https://server:2376", "npipe:////production-server/pipe/docker_engine", ""]) expect(() => assertLocalDockerEndpoint(endpoint)).toThrow("remote");
    const calls: string[][] = [];
    await expect(inspectProdLikeDocker(createProdLikeConfig([], {}, root), async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "context" && args[1] === "show") return "remote-context";
        return JSON.stringify("ssh://production.invalid");
    })).rejects.toThrow("remote");
    expect(calls.map(args => args.slice(0, 2))).toEqual([["context", "show"], ["context", "inspect"]]);
});

test("local Docker preflight checks Linux, compose wait support and the isolated config without starting services", async () => {
    const config = createProdLikeConfig(["--check"], {}, root), calls: string[][] = [];
    const outputs = ["desktop-linux", JSON.stringify("npipe:////./pipe/dockerDesktopLinuxEngine"), "linux", "--wait --wait-timeout", ""];
    const prefix = await inspectProdLikeDocker(config, async (_command: string, args: string[], options: { env: Record<string, string> }) => {
        calls.push(args);
        expect(options.env.DATABASE_URL).toBeUndefined();
        return outputs.shift()!;
    });
    expect(prefix).toEqual(["--context", "desktop-linux"]);
    expect(calls[4]).toEqual([...prefix, ...config.composeArgs, "config", "--quiet"]);
    expect(calls.some(args => args.includes("-d"))).toBe(false);
});

test("dependency readiness and bucket initialization precede migration/bootstrap; application scripts never load env files", async () => {
    const config = createProdLikeConfig([], {}, root), calls: { command: string; args: string[]; env: Record<string, string> }[] = [];
    const checked: number[] = [];
    const runner = { run: async (command: string, args: string[], options: { env: Record<string, string> }) => { calls.push({ command, args, env: options.env }); return ""; } };
    const started = await prepareProdLike(config, runner, { inspectDocker: async () => ["--context", "local"], portCheck: async (port: number) => { checked.push(port); } });
    expect(started).toBe(true);
    expect(checked).toEqual([13100, 13000]);
    expect(calls[0]!.args.slice(-9)).toEqual(["up", "-d", "--build", "--wait", "--wait-timeout", "120", "postgres", "redis", "minio"]);
    expect(calls[1]!.args.slice(-4)).toEqual(["run", "--rm", "--no-deps", "minio-init"]);
    expect(calls.slice(2).map(call => call.args)).toEqual([
        ["--no-env-file", "server/src/migrate.ts"], ["--no-env-file", "server/src/bootstrap.ts"], ["--no-env-file", "tools/dev-prod-like-seed.ts"],
    ]);
    expect(calls.slice(2).every(call => call.env.TASK_MOCK_MODE === "true" && call.env.HOST === "127.0.0.1")).toBe(true);
});

test("failed migrations stop initialization without bootstrap or data-volume deletion", async () => {
    const calls: string[][] = [];
    const runner = { run: async (_command: string, args: string[]) => { calls.push(args); if (args.includes("server/src/migrate.ts")) throw new Error("migration failed"); return ""; } };
    await expect(prepareProdLike(createProdLikeConfig(["--api-only"], {}, root), runner, { inspectDocker: async () => [], portCheck: async () => undefined })).rejects.toThrow("migration failed");
    expect(calls).toHaveLength(3);
    expect(calls.flat()).not.toContain("server/src/bootstrap.ts");
    expect(calls.flat()).not.toContain("down");
    expect(calls.flat()).not.toContain("--volumes");
});

test("preflight does not mutate Docker and stop keeps volumes and other project services intact", async () => {
    for (const mode of ["--check", "--stop"]) {
        const calls: string[][] = [], ports: number[] = [];
        const runner = { run: async (_command: string, args: string[]) => { calls.push(args); return ""; } };
        const config = createProdLikeConfig([mode, "--api-only"], {}, root);
        expect(await prepareProdLike(config, runner, { inspectDocker: async () => ["--context", "local"], portCheck: async (port: number) => { ports.push(port); } })).toBe(false);
        if (mode === "--check") { expect(calls).toEqual([]); expect(ports).toEqual([13100]); }
        else { expect(calls).toEqual([["--context", "local", ...config.composeArgs, "stop", "postgres", "redis", "minio"]]); expect(ports).toEqual([]); }
    }
});

test("an occupied API port fails instead of attaching to or stopping its current owner", async () => {
    const existing = createServer();
    await new Promise<void>(done => existing.listen(0, "127.0.0.1", done));
    try {
        const address = existing.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP test server");
        await expect(checkPort(address.port)).rejects.toThrow();
        expect(existing.listening).toBe(true);
    } finally { await new Promise<void>((done, fail) => existing.close(error => error ? fail(error) : done())); }
});

test("development Compose publishes dependencies only on loopback and owns independent persistent volumes", () => {
    const compose = Bun.YAML.parse(readFileSync(resolve(root, "docker-compose.dev.yml"), "utf8")) as any;
    expect(compose.name).toBe("canvas-prodlike");
    expect(Object.keys(compose.services).sort()).toEqual(["minio", "minio-init", "postgres", "redis"]);
    expect(Object.keys(compose.volumes).sort()).toEqual(["minio-data", "postgres-data", "redis-data"]);
    for (const service of Object.values(compose.services) as any[]) {
        expect(service.env_file).toBeUndefined();
        expect(service.container_name).toBeUndefined();
        for (const port of service.ports || []) expect(port.startsWith("127.0.0.1:")).toBe(true);
        for (const volume of service.volumes || []) expect(compose.volumes).toHaveProperty(volume.split(":")[0]);
    }
    for (const volume of Object.values(compose.volumes) as any[]) expect(volume?.external).not.toBe(true);
});

test("Vite bypasses repository configuration/env loading and preserves the browser Host for the formal same-origin guard", () => {
    const config = createProdLikeConfig([], { PRODLIKE_API_PORT: "23100", PRODLIKE_WEB_PORT: "23000" }, root);
    const vite = prodLikeViteOptions(config);
    expect(vite.configFile).toBe(false);
    expect(vite.envDir).toBe(false);
    expect(vite.server.host).toBe("127.0.0.1");
    expect(vite.server.port).toBe(23000);
    expect(vite.server.strictPort).toBe(true);
    expect(vite.server.proxy["/api"]).toEqual({ target: "http://127.0.0.1:23100", changeOrigin: false });
});

test("the real print-config CLI is safe without Docker and never prints inherited secrets", async () => {
    const config = createProdLikeConfig([], process.env, root);
    const child = Bun.spawn([process.execPath, "--no-env-file", "tools/dev-prod-like.mjs", "--print-config", "--api-only"], {
        cwd: root, env: { ...config.dockerEnv, DATABASE_URL: "postgres://secret.invalid", OPENAI_API_KEY: "prod-like-secret-sentinel" }, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ project: "canvas-prodlike", taskMockMode: true, web: null, loadsApplicationEnvFiles: false });
    expect(output).not.toContain("prod-like-secret-sentinel");
    expect(output).not.toContain("secret.invalid");
});
