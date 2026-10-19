import { loadConfig } from "./config";
import { createDatabase } from "./db";
import { ObjectStorage } from "./object-storage";
import { generateAssetThumbnails } from "./asset-thumbnails";

// Dry-run by default. Explicit --apply writes only derived WebP objects/keys.
const apply = process.argv.includes("--apply");
const limitArg = process.argv.find(value => value.startsWith("--limit="));
const limit = Number(limitArg?.split("=")[1] || 100);
if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error("--limit must be between 1 and 10000");
const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
try {
  const rows = await db.query<{ id: string }>("SELECT id FROM assets WHERE kind='image' AND status='ready' AND deleted_at IS NULL AND (thumbnail_256_key IS NULL OR thumbnail_1024_key IS NULL) ORDER BY created_at,id LIMIT $1", [limit]);
  console.info(`${apply ? "APPLY" : "DRY_RUN"}: ${rows.rows.length} images; originals will not be modified`);
  if (apply) {
    const storage = new ObjectStorage(config);
    let failed = 0;
    for (const { id } of rows.rows) {
      try { await generateAssetThumbnails(db, storage, id); console.info(id, "ready"); }
      catch (error) { failed++; console.error(id, error instanceof Error ? error.message : "failed"); }
    }
    if (failed) process.exitCode = 1;
  }
} finally { await db.end(); }
