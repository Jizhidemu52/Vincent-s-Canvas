import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MARK_IMAGE_PROVIDER_ID } from "../../../shared/mark-image-models";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
integration("new creative module migration", () => {
  test("050 extends only the action constraint, retaining existing quick settings and ordinary tool bindings", async () => {
    const fixture = await createIsolatedPostgres();
    const query = (sql: string, values: unknown[] = []) => fixture.db.query<Record<string, any>>(sql, values);
    try {
      const provider = randomUUID(), model = randomUUID();
      await query("INSERT INTO providers(id,name,protocol,base_url,enabled) VALUES($1,'Migration fixture','apimart','https://no-network.invalid/v1',true)", [provider]);
      await query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,enabled,credit_cost,rmb_cost) VALUES($1,$2,'Fixture','gpt-image-2.6-flare',ARRAY['edit'],true,0,0)", [model, provider]);
      for (const action of ["remove-background", "hd-upscale"]) await query("INSERT INTO quick_image_configurations(action,model_config_id,prompt,parameters,configuration_version) VALUES($1,$2,$3,$4::jsonb,7)", [action, model, `UNCHANGED_${action}`, JSON.stringify({ resolution: "2k" })]);
      const quickBefore = (await query("SELECT * FROM quick_image_configurations ORDER BY action")).rows;
      const bindingsBefore = (await query("SELECT * FROM tool_api_configurations ORDER BY tool_key")).rows;
      const flagsBefore = (await query("SELECT * FROM module_flags ORDER BY module_key")).rows;
      await query("ALTER TABLE quick_image_configurations DROP CONSTRAINT quick_image_configurations_action_check, ADD CONSTRAINT quick_image_configurations_action_check CHECK (action IN ('remove-background','hd-upscale'))");
      await query(await readFile(new URL("../../src/migrations/050_quick_image_item_extract.sql", import.meta.url), "utf8"));
      expect((await query("SELECT * FROM quick_image_configurations ORDER BY action")).rows).toEqual(quickBefore);
      expect((await query("SELECT * FROM tool_api_configurations ORDER BY tool_key")).rows).toEqual(bindingsBefore);
      expect((await query("SELECT * FROM module_flags ORDER BY module_key")).rows).toEqual(flagsBefore);
      await query("INSERT INTO quick_image_configurations(action,model_config_id,prompt) VALUES('item-extract',$1,'New independent extraction')", [model]);
      await expect(query("INSERT INTO quick_image_configurations(action,model_config_id,prompt) VALUES('unknown-action',$1,'Rejected')", [model])).rejects.toThrow();
      expect((await query("SELECT * FROM quick_image_configurations WHERE action <> 'item-extract' ORDER BY action")).rows).toEqual(quickBefore);
    } finally { await fixture.close(); }
  }, 30_000);
  test("051 admits only the two new modules, picks the exact Flare provider and preserves existing bindings", async () => {
    const fixture = await createIsolatedPostgres();
    const query = (sql: string, values: unknown[] = []) => fixture.db.query<Record<string, any>>(sql, values);
    try {
      const tools = ["creative-virtual-try-on", "creative-sketch-to-photo"];
      expect((await query("SELECT tool_key FROM tool_api_configurations WHERE tool_key=ANY($1::text[]) ORDER BY tool_key", [tools])).rows).toHaveLength(2);
      expect((await query("SELECT module_key,enabled FROM module_flags WHERE module_key=ANY($1::text[])", [tools])).rows.every(row => row.enabled)).toBe(true);
      await expect(query("INSERT INTO tool_api_configurations(tool_key,enabled) VALUES('creative-item-extract',true)")).rejects.toThrow();
      await expect(query("INSERT INTO module_flags(module_key,enabled) VALUES('creative-unknown',true)")).rejects.toThrow();
      const provider = randomUUID(), expected = randomUUID(), decoy = randomUUID();
      for (const id of [MARK_IMAGE_PROVIDER_ID, provider]) await query("INSERT INTO providers(id,name,protocol,base_url,enabled) VALUES($1,$2,'apimart','https://no-network.invalid/v1',true) ON CONFLICT(id) DO UPDATE SET protocol='apimart',enabled=true", [id, `Test ${id}`]);
      for (const [id, owner] of [[expected, MARK_IMAGE_PROVIDER_ID], [decoy, provider]]) await query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,enabled,credit_cost,rmb_cost) VALUES($1,$2,'Flare fixture','gpt-image-2.6-flare',ARRAY['generate','edit'],true,0,0)", [id, owner]);
      const before = (await query("SELECT * FROM tool_api_configurations WHERE NOT (tool_key=ANY($1::text[])) ORDER BY tool_key", [tools])).rows;
      await query("DELETE FROM tool_api_configurations WHERE tool_key=ANY($1::text[])", [tools]);
      const sql = await readFile(new URL("../../src/migrations/051_new_creative_scenes.sql", import.meta.url), "utf8");
      const insert = sql.slice(sql.indexOf("INSERT INTO tool_api_configurations"));
      await query(insert);
      expect((await query("SELECT model_config_id FROM tool_api_configurations WHERE tool_key=ANY($1::text[])", [tools])).rows.map(row => row.model_config_id)).toEqual([expected, expected]);
      expect((await query("SELECT * FROM tool_api_configurations WHERE NOT (tool_key=ANY($1::text[])) ORDER BY tool_key", [tools])).rows).toEqual(before);
      await query("UPDATE tool_api_configurations SET model_config_id=$1,enabled=false WHERE tool_key=$2", [decoy, tools[0]]);
      const customized = (await query("SELECT * FROM tool_api_configurations ORDER BY tool_key")).rows;
      await query(insert);
      expect((await query("SELECT * FROM tool_api_configurations ORDER BY tool_key")).rows).toEqual(customized);
    } finally { await fixture.close(); }
  }, 30_000);
});
