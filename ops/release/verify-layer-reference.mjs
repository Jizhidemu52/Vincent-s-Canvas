// Runs with Bun inside the exact release API image, without network or credentials.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { validateSeedream55Reference } from "/app/src/seedream55-reference.ts";

assert.equal(process.platform, "linux");
const bytes = await readFile("/opt/canvas-fixture/reference.heic");
const hash = value => createHash("sha256").update(value).digest("hex");
const expectedHash = "4ea589f9728e7e3c08060473ffde0189719a1810550571de693d743e1bf86292";
assert.equal(hash(bytes), expectedHash);
// Explicitly unavailable FFmpeg proves HEIC does not accidentally depend on
// the host's newer decoder. Other six input formats keep their existing path.
process.env.FFMPEG_PATH = "/unavailable-in-this-codec-test";
const heic = await validateSeedream55Reference({ bytes, mimeType: "image/heic" });
assert.deepEqual(heic, { width: 3024, height: 4032, mimeType: "image/heic" });
assert.equal(hash(bytes), expectedHash);
// This is a derived container-brand fixture, not an independent real HEIF photo.
const heifBytes = Buffer.from(bytes);
heifBytes.write("mif1", 8, 4, "ascii");
const derivedHash = hash(heifBytes);
const heif = await validateSeedream55Reference({ bytes: heifBytes, mimeType: "image/heif" });
assert.deepEqual(heif, { width: 3024, height: 4032, mimeType: "image/heif" });
assert.equal(hash(heifBytes), derivedHash);
process.stdout.write(JSON.stringify({ schema: 1, status: "passed", originalSha256: expectedHash,
  originalBytesUnchanged: true, realHeic: heic, derivedHeif: heif, ffmpegUsed: false, paidRequests: 0 }) + "\n");
