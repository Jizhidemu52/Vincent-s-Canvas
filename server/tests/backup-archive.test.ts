import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, delimiter } from "node:path";
import { tmpdir } from "node:os";

const isWindows = process.platform === "win32";
const python = Bun.which(isWindows ? "python" : "python3");
const bash = isWindows ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const enabled = python && bash && await Bun.file(bash).exists() ? test : test.skip;
const scripts = resolve(import.meta.dir, "../../ops/backup");
const stub = resolve(import.meta.dir, "helpers/backup-tool-stub.py");
type Call = { tool: string; args: string[]; kind?: string; sql?: string; config?: string };

async function fixture(extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "canvas-backup-test-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const bashEnv = join(root, "bash-env.sh");
  await writeFile(bashEnv, 'export PATH="$BACKUP_STUB_POSIX_BIN:$PATH"\n');
  for (const tool of ["psql", "pg_dump", "pg_restore", "age", "mc", "curl"]) {
    const filename = join(bin, tool + (isWindows ? ".cmd" : ""));
    await writeFile(filename, isWindows
      ? `@echo off\r\n"%PYTHON_BIN%" "%BACKUP_STUB_SCRIPT%" ${tool} %*\r\n`
      : `#!/usr/bin/env bash\nexec "$PYTHON_BIN" "$BACKUP_STUB_SCRIPT" ${tool} "$@"\n`);
    if (!isWindows) await chmod(filename, 0o755);
  }
  const source = join(root, "storage/source/assets");
  const backup = join(root, "storage/backup/archives");
  await mkdir(join(source, "users/example"), { recursive: true });
  await mkdir(backup, { recursive: true });
  await writeFile(join(source, "users/example/original.png"), "original-bytes");
  await writeFile(join(source, "users/example/thumb.webp"), "thumb");
  await writeFile(join(root, "identity.txt"), "offline-stub-identity");
  const references = [
    { key: "users/example/original.png", expected_bytes: 14, mime_type: "image/png" },
    { key: "users/example/thumb.webp", expected_bytes: null, mime_type: "image/webp" },
  ];
  const inheritedPath = process.env.PATH || process.env.Path || "";
  const env = { ...process.env, PATH: [bin, ...(isWindows ? ["C:/Program Files/Git/usr/bin"] : []), inheritedPath].join(delimiter), PYTHON_BIN: python!,
    BASH_ENV: bashEnv.replaceAll("\\", "/"), BACKUP_STUB_POSIX_BIN: bin.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_match, drive) => "/" + drive.toLowerCase()),
    BACKUP_STUB_ROOT: root, BACKUP_STUB_SCRIPT: stub, BACKUP_STUB_REFERENCES: JSON.stringify(references),
    DATABASE_URL: "postgres://fixture:database-password@db.invalid:5432/canvas", S3_ENDPOINT: "http://source.invalid:9000",
    S3_BUCKET: "assets", S3_ACCESS_KEY_ID: "fixture-source-user", S3_SECRET_ACCESS_KEY: "fixture-source-key",
    BACKUP_S3_ENDPOINT: "https://backup.invalid", BACKUP_S3_BUCKET: "archives", BACKUP_S3_ACCESS_KEY_ID: "fixture-backup-user",
    BACKUP_S3_SECRET_ACCESS_KEY: "fixture-backup-key", BACKUP_AGE_RECIPIENT: "age1fixturepublickey", BACKUP_RUN_ONCE: "true",
    BACKUP_FAILURE_WEBHOOK_URL: "https://notify.invalid/private-token", BACKUP_AGE_IDENTITY_FILE: join(root, "identity.txt"),
    ...extra };
  delete (env as Record<string, string | undefined>).Path;
  async function run(operation = "backup", args: string[] = [], overrides: Record<string, string> = {}) {
    const child = Bun.spawn([bash!, join(scripts, operation + ".sh").replaceAll("\\", "/"), ...args], { env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  }
  const calls = async (): Promise<Call[]> => {
    const directory = join(root, "calls");
    return Promise.all((await readdir(directory).catch(() => [])).sort().map(async name => JSON.parse(await readFile(join(directory, name), "utf8"))));
  };
  const snapshots = async () => await readdir(join(backup, "canvas/snapshots")).catch(() => []);
  return { root, source, backup, env, run, calls, snapshots, close: () => rm(root, { recursive: true, force: true }) };
}

enabled("backup shell encrypts database and manifest, copies every referenced object, then publishes COMPLETE", async () => {
  const f = await fixture();
  try {
    const result = await f.run();
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const completed = JSON.parse(result.stdout.trim());
    expect(completed).toMatchObject({ event: "backup.completed", objectCount: 2, consistency: "postgres-snapshot-with-online-reference-verification" });
    const root = join(f.backup, "canvas/snapshots", completed.snapshot);
    expect(await readFile(join(root, "db.dump.age"), "utf8")).toStartWith("age-stub:");
    expect(await readFile(join(root, "db.dump.age"), "utf8")).not.toContain("unencrypted");
    expect(await readdir(join(root, "media"))).toHaveLength(2);
    const calls = await f.calls();
    expect(calls.at(-1)?.args.at(-1)).toEndWith("/COMPLETE.json");
    expect(calls.find(call => call.kind === "manifest")?.sql).toContain("SET TRANSACTION SNAPSHOT '00000001-00000002-1'");
    expect(calls.find(call => call.tool === "pg_dump")?.args).toContain("--snapshot=00000001-00000002-1");
    expect(calls.find(call => call.kind === "manifest")?.sql).toContain("thumbnail_256_key");
    expect(calls.find(call => call.kind === "manifest")?.sql).toContain("design_library_images");
    expect(calls.some(call => call.tool === "mc" && ["rm", "mirror", "alias"].includes(call.args[0]!))).toBe(false);
    expect(JSON.stringify(calls.filter(call => call.tool !== "curl"))).not.toContain("database-password");
    expect(result.stdout + result.stderr).not.toContain("fixture-source-key");
    expect(await readFile(join(f.source, "users/example/original.png"), "utf8")).toBe("original-bytes");
  } finally { await f.close(); }
}, 30_000);

enabled.each(["missing-media", "dump-failure", "age-failure", "copy-failure", "corrupt-copy"])("backup %s exits nonzero, alerts without secrets and cannot publish a complete snapshot", async mode => {
  const f = await fixture({ BACKUP_STUB_MODE: mode });
  try {
    if (mode === "missing-media") await rm(join(f.source, "users/example/thumb.webp"));
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('"event":"backup.failed"');
    for (const snapshot of await f.snapshots()) expect(await Bun.file(join(f.backup, "canvas/snapshots", snapshot, "COMPLETE.json")).exists()).toBe(false);
    const calls = await f.calls();
    const alert = calls.find(call => call.tool === "curl");
    expect(alert, result.stdout + result.stderr + JSON.stringify(calls)).toBeDefined();
    expect(alert!.args).not.toContain("https://notify.invalid/private-token");
    for (const secret of ["database-password", "fixture-source-key", "fixture-backup-key"]) {
      expect(result.stdout + result.stderr).not.toContain(secret);
      expect(alert!.config).not.toContain(secret);
    }
    expect(calls.some(call => call.tool === "mc" && ["rm", "mirror"].includes(call.args[0]!))).toBe(false);
  } finally { await f.close(); }
}, 30_000);

enabled.each(["http://source.invalid:9000", "https://SOURCE.invalid:9443/"])("backup rejects a destination on source host: %s", async endpoint => {
  const f = await fixture({ BACKUP_S3_ENDPOINT: endpoint });
  try {
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("backup_must_use_external_host");
    expect((await f.calls()).some(call => call.tool === "mc")).toBe(false);
  } finally { await f.close(); }
});

enabled.each(["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY", "BACKUP_AGE_RECIPIENT"])("backup has no unsafe fallback when %s is missing", async name => {
  const f = await fixture({ [name]: "" });
  try {
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("configuration." + name);
    expect((await f.calls()).some(call => call.tool !== "curl")).toBe(false);
  } finally { await f.close(); }
});

enabled("backup validates MIME before publishing a snapshot that restore would reject", async () => {
  const f = await fixture({ BACKUP_STUB_REFERENCES: JSON.stringify([
    { key: "users/example/original.png", expected_bytes: 14, mime_type: "image/png;invalid-metadata" },
  ]) });
  try {
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("manifest.mime_type");
    expect(await f.snapshots()).toEqual([]);
    expect((await f.calls()).some(call => call.tool === "mc" && call.args[0] === "cp")).toBe(false);
  } finally { await f.close(); }
});

enabled("restore refuses implicit snapshots and unconfirmed destructive writes", async () => {
  const f = await fixture();
  try {
    expect((await f.run("restore")).code).not.toBe(0);
    expect((await f.run("restore", ["example-snapshot"])).code).toBe(1);
    expect((await f.calls()).some(call => call.tool === "pg_restore" || call.tool === "mc")).toBe(false);
  } finally { await f.close(); }
});

enabled.each(["complete", "missing-media", "corrupt-dump"])("restore validates all inputs before any destructive write: %s", async scenario => {
  const f = await fixture();
  try {
    const backup = await f.run();
    expect(backup.code, backup.stdout + backup.stderr).toBe(0);
    const snapshot = JSON.parse(backup.stdout.trim()).snapshot;
    const root = join(f.backup, "canvas/snapshots", snapshot);
    if (scenario === "missing-media") await rm(join(root, "media", (await readdir(join(root, "media")))[0]!));
    if (scenario === "corrupt-dump") await writeFile(join(root, "db.dump.age"), "corrupted");
    await rm(join(f.root, "calls"), { recursive: true, force: true });
    const restore = await f.run("restore", [snapshot], { RESTORE_ALLOW_DESTRUCTIVE: "true", RESTORE_WRITES_STOPPED: "true" });
    const calls = await f.calls();
    const dbWrite = calls.findIndex(call => call.tool === "pg_restore" && call.args.includes("--clean"));
    const mediaWrite = calls.findIndex(call => call.tool === "mc" && call.args[0] === "cp" && call.args.at(-1)?.startsWith("source/"));
    if (scenario === "complete") {
      expect(restore.code, restore.stdout + restore.stderr).toBe(0);
      expect(dbWrite).toBeGreaterThan(mediaWrite);
      expect(mediaWrite).toBeGreaterThan(calls.findIndex(call => call.tool === "pg_restore" && call.args.includes("--list")));
      expect(calls[dbWrite]!.args).toContain("--single-transaction");
      expect(calls[dbWrite]!.args).not.toContain(f.env.DATABASE_URL);
    } else {
      expect(restore.code).toBe(1);
      expect(dbWrite).toBe(-1);
      expect(mediaWrite).toBe(-1);
    }
  } finally { await f.close(); }
}, 30_000);
