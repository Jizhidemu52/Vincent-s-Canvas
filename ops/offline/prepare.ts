import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { offlineCompose } from "./compose";

const [revision, destination] = Bun.argv.slice(2);
if (!destination) throw new Error("Usage: bun ops/offline/prepare.ts COMMIT NEW_OUTPUT_DIRECTORY");
const config = offlineCompose(Bun.YAML.parse(await Bun.file("docker-compose.yml").text()) as any, revision!);
const out = resolve(destination);
// Refuse an existing directory: no stale files, user credentials or previous image archives.
await mkdir(out, { recursive: false });
await mkdir(resolve(out, "ops/preflight"), { recursive: true });
await mkdir(resolve(out, "server/src"), { recursive: true });
await Bun.write(resolve(out, "compose.json"), JSON.stringify(config, null, 2) + "\n");
const images = [...new Set(Object.values(config.services).map(service => service.image as string))];
await Bun.write(resolve(out, "images.txt"), images.join("\n") + "\n");
await Bun.write(resolve(out, "REVISION"), revision + "\n");
await Bun.write(resolve(out, ".env.example"), (await Bun.file(".env.example").text()).replace(/^WECOM_CALLBACK_URL=.*$/m, "WECOM_CALLBACK_URL="));
for (const file of ["ops/preflight/production-preflight.ts", "server/src/production-readiness.ts"]) {
    await copyFile(file, resolve(out, file));
}
await copyFile("ops/offline/offline.sh", resolve(out, "offline.sh"));
await copyFile("docs/manual/baota-offline-installation.md", resolve(out, "INSTALL.md"));
console.log(`Prepared ${images.length} image references; credentials and business data excluded.`);
