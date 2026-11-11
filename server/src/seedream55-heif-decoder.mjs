// Isolated, network-free verification only. Original image bytes never leave
// this process or get re-encoded. libheif-js (LGPL-3.0) supplies the HEIF parser,
// grid/HEVC decoder and orientation handling, independent of system FFmpeg.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

try {
  if (process.versions.bun) throw new Error("Native Node required");
  const bytes = await readFile(process.argv[2]);
  if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new Error("Invalid image byte size");
  const require = createRequire(import.meta.url);
  // This entry contains its WASM bytes; it cannot download code at runtime.
  const libheif = await require("libheif-js/libheif-wasm/libheif-bundle.js")({ print() {}, printErr() {} });
  const images = new libheif.HeifDecoder().decode(bytes);
  try {
    const image = images.find(item => item.is_primary());
    if (!image) throw new Error("No primary image");
    const width = image.get_width(), height = image.get_height();
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > 36_000_000) throw new Error("Invalid primary image dimensions");
    const decoded = await new Promise((resolve, reject) => image.display({ width, height, data: new Uint8ClampedArray(width * height * 4) }, result => result ? resolve(result) : reject(new Error("Invalid HEIF payload"))));
    if (decoded.width !== width || decoded.height !== height || decoded.data.byteLength !== width * height * 4) throw new Error("Invalid decoded pixels");
    process.stdout.write(JSON.stringify({ width, height }));
  } finally { for (const image of images) image.free(); }
} catch {
  // Do not expose filenames, image metadata or internal decoder diagnostics.
  process.exitCode = 1;
}
