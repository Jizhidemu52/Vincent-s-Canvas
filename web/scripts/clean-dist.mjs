import { existsSync, rmSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(scriptsDir, "..");
const outputDir = resolve(webDir, "dist");

if (relative(webDir, outputDir) !== "dist") {
    throw new Error(`Refusing to clean an unexpected build directory: ${outputDir}`);
}

if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    console.log("Removed stale web/dist build artifacts.");
}
