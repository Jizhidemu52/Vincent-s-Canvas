// Test-only preload for the isolated real demo process. Record raw BLOB SELECTs
// separately from length(bytes), which SQLite obtains without materializing it.
import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";

const auditPath = process.env.DEMO_MEDIA_READ_AUDIT;
if (!auditPath || process.env.NODE_ENV !== "test") throw new Error("Media read audit requires an isolated test environment");
const original = Database.prototype.query;
Reflect.set(Database.prototype, "query", function(this: Database, sql: string) {
  const projection = sql.match(/^\s*select\s+([\s\S]*?)\s+from\s+demo_assets\b/i)?.[1]?.replace(/length\s*\(\s*bytes\s*\)/gi, "stored_length");
  if (projection && /\bbytes\b|\*/i.test(projection)) appendFileSync(auditPath, "original-read\n");
  return Reflect.apply(original, this, arguments);
});
