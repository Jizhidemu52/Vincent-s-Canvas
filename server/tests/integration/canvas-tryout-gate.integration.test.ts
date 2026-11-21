import { expect, test } from "bun:test";
import { moduleKeys, isModuleEnabled } from "../../src/module-flags";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

(process.env.PGLITE_RUNTIME_PATH ? test : test.skip)("migrated canvas tryout requires explicit activation and an enabled canvas parent", async () => {
    const sql=await createIsolatedPostgres();
    try {
        const flags=(await sql.db.query("SELECT module_key FROM module_flags")).rows.map(row=>row.module_key);
        expect(flags.sort()).toEqual([...moduleKeys].sort());
        expect(await isModuleEnabled(sql.db,"canvas-tryout")).toBe(false);
        await sql.db.query("UPDATE module_flags SET enabled=true WHERE module_key='canvas-tryout'");
        expect(await isModuleEnabled(sql.db,"canvas-tryout")).toBe(true);
        await sql.db.query("UPDATE module_flags SET enabled=false WHERE module_key='canvas'");
        expect(await isModuleEnabled(sql.db,"canvas-tryout")).toBe(false);
    } finally { await sql.close(); }
});
