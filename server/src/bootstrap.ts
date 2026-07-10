import { loadConfig } from "./config";
import { createDatabase } from "./db";
import { hashPassword } from "./security";

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const exists = await db.query("SELECT id FROM users WHERE role='super_admin' LIMIT 1");
if (exists.rowCount) {
    console.log("A super administrator already exists; no changes made.");
} else {
    if (!config.BOOTSTRAP_ADMIN_USERNAME || !config.BOOTSTRAP_ADMIN_PASSWORD) {
        throw new Error("Set BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD before first bootstrap");
    }
    if (config.BOOTSTRAP_ADMIN_PASSWORD === "change-this-before-first-run") {
        throw new Error("Refusing to use the example bootstrap password");
    }
    const result = await db.query(
        `INSERT INTO users(username,display_name,password_hash,role,must_change_password,credit_balance,credit_limit)
         VALUES($1,$2,$3,'super_admin',true,0,0) RETURNING id,username`,
        [config.BOOTSTRAP_ADMIN_USERNAME, config.BOOTSTRAP_ADMIN_DISPLAY_NAME, await hashPassword(config.BOOTSTRAP_ADMIN_PASSWORD)],
    );
    console.log(`Created super administrator ${result.rows[0].username} (${result.rows[0].id}).`);
}
await db.end();
