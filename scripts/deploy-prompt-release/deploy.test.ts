import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { assertClean, assertPublicPackage, assertReleaseName, files, manifest, originals, requiredSource, tarOptions } from "./package.mjs";
import { assertOptimizer, capture, expectedKeys, verify } from "./recipe-state";
import { createIsolatedPostgres } from "../../server/tests/helpers/isolated-postgres";
import { postgresPromptRecipeStore } from "../../server/src/prompt-recipe-postgres";
import { importPromptRecipes, parsePromptRecipeDocument } from "../../server/src/prompt-recipe-import";

const directory = import.meta.dir;
const repo = resolve(directory, "../..");
let scratch: string;
beforeAll(async () => { scratch = await mkdtemp(join(tmpdir(), "canvas-prompt-deploy-contract-")); });
afterAll(async () => {
  if (dirname(scratch) !== resolve(tmpdir()) || !scratch.split(/[\\/]/).at(-1)?.startsWith("canvas-prompt-deploy-contract-")) throw Error("Unsafe fixture cleanup path");
  await rm(scratch, { recursive: true, force: true });
});

test("release names reject path escape and public manifests reject secrets/runtime databases", () => {
  expect(assertReleaseName("canvas-abcdef1-20261025-prompt")).toBe("canvas-abcdef1-20261025-prompt");
  for (const value of ["../../release", "canvas-abcdef1-20261025-prompt/x", "canvas-xx-20261025-prompt"]) expect(() => assertReleaseName(value)).toThrow();
  expect(() => assertPublicPackage(["server/.env.example", "server/scripts/import-prompt-recipes.ts", ...originals])).not.toThrow();
  for (const name of [".env", "server/.env.production", "server/state.sqlite", "server/state.sqlite3", "server/state.db", "server/state.db-wal", "data.dump", "data.backup", "data.bak", "key.pem", "node_modules/a.js"]) expect(() => assertPublicPackage([name])).toThrow();
});

test("packaging rejects unstaged, staged and untracked source and accepts clean committed HEAD", async () => {
  const fixture = join(scratch, "git");
  await mkdir(fixture);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture, stdio: "pipe", windowsHide: true });
  git("init");
  await writeFile(join(fixture, "source.txt"), "committed");
  git("add", "source.txt");
  git("-c", "user.name=Isolated release test", "-c", "user.email=isolated@example.invalid", "commit", "-m", "Fixture");
  expect(() => assertClean(fixture)).not.toThrow();
  await writeFile(join(fixture, "source.txt"), "uncommitted");
  expect(() => assertClean(fixture)).toThrow();
  git("add", "source.txt");
  expect(() => assertClean(fixture)).toThrow();
  git("-c", "user.name=Isolated release test", "-c", "user.email=isolated@example.invalid", "commit", "-m", "Fixture update");
  await writeFile(join(fixture, "unknown.txt"), "untracked");
  expect(() => assertClean(fixture)).toThrow();
});

test("UTF-8 Chinese archive paths and exact bytes survive extraction and repackaging", async () => {
  const fixture = join(scratch, "unicode");
  const first = join(fixture, "first"), second = join(fixture, "second");
  await mkdir(first, { recursive: true });
  await mkdir(second);
  const source = join(fixture, "source.tar"), packed = join(fixture, "packed.tar.gz");
  execFileSync("git", ["archive", "--format=tar", `--output=${source}`, "HEAD", originals[0]], { cwd: repo, windowsHide: true });
  execFileSync("tar", [...tarOptions, "-xf", source, "-C", first], { cwd: repo, windowsHide: true });
  const expected = execFileSync("git", ["show", `HEAD:${originals[0]}`], { cwd: repo, windowsHide: true });
  expect(await readFile(join(first, originals[0]))).toEqual(expected);
  execFileSync("tar", [...tarOptions, "-czf", packed, "-C", first, "."], { cwd: repo, windowsHide: true });
  const compressed = await readFile(packed);
  expect(compressed.subarray(0, 2).toString("hex")).toBe("1f8b");
  // Verify gzip independently of Windows bsdtar's intermittent compressed-extract exit 5 under Bun tests.
  const unpacked = join(fixture, "repacked.tar");
  await writeFile(unpacked, gunzipSync(compressed));
  execFileSync("tar", [...tarOptions, "-xf", unpacked, "-C", second], { cwd: repo, windowsHide: true });
  expect(await readFile(join(second, originals[0]))).toEqual(expected);
  expect(await files(first)).toEqual(await files(second));
});

test("server manifest includes scripts and all nested tracked source rather than src-only", async () => {
  const fixture = join(scratch, "hashes");
  await mkdir(join(fixture, "scripts"), { recursive: true });
  await mkdir(join(fixture, "src"));
  await writeFile(join(fixture, "package.json"), "package");
  await writeFile(join(fixture, "scripts/import-prompt-recipes.ts"), "importer");
  await writeFile(join(fixture, "src/index.ts"), "production");
  const names = await files(fixture);
  expect(names).toEqual(["package.json", "scripts/import-prompt-recipes.ts", "src/index.ts"]);
  expect(await manifest(fixture, names)).toContain(`${createHash("sha256").update("importer").digest("hex")}  scripts/import-prompt-recipes.ts`);
  for (const required of requiredSource) expect((await readFile(join(repo, required))).length).toBeGreaterThan(0);
});

test("deployment contract uses frozen archives, explicit migrate/import order, preserved runtime config and non-destructive rollback", async () => {
  const packageCode = await readFile(join(directory, "package.mjs"), "utf8");
  const prepare = await readFile(join(directory, "prepare.sh"), "utf8");
  const cutover = await readFile(join(directory, "cutover.sh"), "utf8");
  const dockerfile = await readFile(join(directory, "Dockerfile.api"), "utf8");
  const dockerIgnore = await readFile(join(repo, ".dockerignore"), "utf8");
  expect(packageCode.indexOf("['archive'")).toBeLessThan(packageCode.indexOf("['run', 'build']"));
  expect(packageCode).toContain("await manifest(buildRoot, sourceNames) !== sourceManifest");
  expect(packageCode).toContain("await files(path.join(root, 'server'))");
  expect(prepare).toContain('cp -p "$previous/compose.runtime.yml" compose.runtime.yml');
  expect(cutover.indexOf("api bun src/migrate.ts")).toBeLessThan(cutover.indexOf("api bun scripts/import-prompt-recipes.ts"));
  expect(cutover).toContain('--model "$optimizer"');
  expect(cutover).toContain("--activate");
  expect(cutover).toContain("652b3d3c-93bf-419e-851f-31c5e101daf6");
  expect(cutover).not.toMatch(/DROP\s+TABLE|TRUNCATE|down\s+-v|pg_restore\s+--clean|UPDATE\s+tool_api_configurations/i);
  expect(dockerfile).toContain("COPY server/ /app/");
  expect(dockerfile).toContain('CMD ["bun", "src/index.ts"]');
  expect(dockerfile).toContain("COPY docs/manual/prompt-optimization/");
  expect(dockerIgnore.lastIndexOf("!**/.env.example")).toBeGreaterThan(dockerIgnore.lastIndexOf("**/.env.*"));
});

test("both operational scripts parse in Bash without executing any external operation", () => {
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  for (const name of ["prepare.sh", "cutover.sh"]) {
    expect(() => execFileSync(bash, ["-n", join(directory, name)], { stdio: "pipe", windowsHide: true })).not.toThrow();
  }
});

const isolated = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
isolated("isolated PostgreSQL recipe import release guard", () => {
  test("18 initial activations preserve employee/chat state; repeated import preserves later administrator versions/settings", async () => {
    const fixture = await createIsolatedPostgres();
    try {
      const db = fixture.db, provider = randomUUID(), model = randomUUID(), otherModel = randomUUID(), employee = randomUUID(), batch = randomUUID();
      await db.query("CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())");
      await db.query("INSERT INTO schema_migrations(name) VALUES('043_prompt_recipes.sql')");
      await db.query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Offline release fixture','openai','https://no-network.invalid')", [provider]);
      for (const id of [model, otherModel]) await db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,$2,'Offline optimizer',$3,ARRAY['chat'],0,0)", [id, provider, `offline-${id}`]);
      await db.query("INSERT INTO users(id,username,display_name,role,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,$2,'Offline employee','designer',123,200,200)", [employee, `offline-${employee}`]);
      await db.query("UPDATE tool_api_configurations SET model_config_id=$1 WHERE tool_key='gpt-chat'", [otherModel]);
      await db.query("INSERT INTO batch_tasks(id,request_id,user_id,project_id,operation_type,model_config_id,prompt,total_items,tool_key) VALUES($1,$2,$3,'offline-project','batch_image',$4,'Preserve this original batch prompt',2,'canvas-batch')", [batch, randomUUID(), employee, model]);
      await assertOptimizer(db, model);
      await expect(assertOptimizer(db, randomUUID())).rejects.toThrow("missing, disabled or not chat capable");
      const source = await readFile(join(repo, originals[0]), "utf8");
      expect(parsePromptRecipeDocument(source).map(value => value.key).sort()).toEqual(expectedKeys);
      const store = postgresPromptRecipeStore(db), before = await capture(db);
      const first = await importPromptRecipes(store, source, { actorId: "offline-release", modelConfigId: model, activate: true });
      expect(first).toHaveLength(18);
      expect(first.every(value => value.activated)).toBe(true);
      expect((await verify(db, before, model)).verifiedRecipeKeys).toHaveLength(18);
      const original = await store.get("free-optimize"), originalVersion = await store.getVersion(original.currentVersionId!);
      const edited = await store.saveVersion("free-optimize", { systemPrompt: "Administrator edited rules after deployment.", fieldTemplate: originalVersion.fieldTemplate, modelOverrides: originalVersion.modelOverrides, fallbackPrompt: originalVersion.fallbackPrompt, outputLanguage: originalVersion.outputLanguage, changeNote: "retain this version" }, "offline-admin");
      await store.activate("free-optimize", edited.id);
      await store.update("free-optimize", { name: "Administrator name", enabled: false, modelConfigId: otherModel, failurePolicy: "stop" });
      const later = await capture(db);
      const repeated = await importPromptRecipes(store, source, { actorId: "offline-release-repeat", modelConfigId: model, activate: true });
      expect(repeated.every(value => !value.activated)).toBe(true);
      expect((await verify(db, later, model)).preservedExistingRecipes).toBe(18);
      expect(await store.get("free-optimize")).toMatchObject({ currentVersionId: edited.id, enabled: false, modelConfigId: otherModel, name: "Administrator name" });
      expect((await db.query("SELECT model_config_id FROM tool_api_configurations WHERE tool_key='gpt-chat'")).rows[0]?.model_config_id).toBe(otherModel);
      await db.query("UPDATE batch_tasks SET admission_input_hash='new admission metadata',admission_status='interrupted',admission_token=$2,admission_lease_expires_at=now(),admission_failures='[{\"index\":0,\"code\":\"OFFLINE_FIXTURE\"}]'::jsonb WHERE id=$1", [batch, randomUUID()]);
      expect((await verify(db, later, model)).preservedExistingRecipes).toBe(18);
      await db.query("UPDATE batch_tasks SET prompt='Unexpected old business field mutation' WHERE id=$1", [batch]);
      await expect(verify(db, later, model)).rejects.toThrow("Non-prompt database tables changed");
      await db.query("UPDATE batch_tasks SET prompt='Preserve this original batch prompt' WHERE id=$1", [batch]);
      await db.query("UPDATE users SET credit_balance=122 WHERE id=$1", [employee]);
      await expect(verify(db, later, model)).rejects.toThrow("Non-prompt database tables changed");
    } finally { await fixture.close(); }
  }, 30_000);
});
