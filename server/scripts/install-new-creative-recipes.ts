import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDatabase } from "../src/db";
import { sqlitePromptRecipeStore } from "../src/demo-prompt-recipes";
import { postgresPromptRecipeStore } from "../src/prompt-recipe-postgres";
import { CHAT_COMPLETION_PROTOCOLS } from "../src/routes/chat";
import { installNewCreativeRecipes, newCreativeRecipes } from "../src/new-creative-recipes";

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  sqlite: { type: "string" }, actor: { type: "string" }, "optimizer-model": { type: "string" },
  activate: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false },
} });
if (values["dry-run"]) {
  console.log(JSON.stringify({ recipes: newCreativeRecipes.map(({ key, name, systemPrompt }) => ({ key, name, characters: systemPrompt.length })), existingConfigurations: "preserved" }, null, 2));
} else {
  if (!values.actor || !values["optimizer-model"]) throw new Error("必须显式指定 --actor 与已启用扩写模型的配置 ID --optimizer-model；未修改数据");
  const options = { actorId: values.actor, optimizerModelConfigId: values["optimizer-model"], activate: values.activate };
  if (values.sqlite) {
    // Demo models live outside SQLite; the caller must use an enabled model ID
    // from that same demo runtime. Compilation revalidates it before any request.
    const database = sqlitePromptRecipeStore(resolve(values.sqlite));
    try { console.log(JSON.stringify(await installNewCreativeRecipes(database.store, options), null, 2)); }
    finally { database.close(); }
  } else {
    if (!process.env.DATABASE_URL) throw new Error("未配置 DATABASE_URL，未修改数据");
    const database = createDatabase(process.env.DATABASE_URL);
    try {
      const actor = (await database.query("SELECT id FROM users WHERE id::text=$1 AND role='super_admin' AND status='active'", [options.actorId])).rows[0];
      if (!actor) throw new Error("--actor 必须对应目标数据库中的启用超级管理员；未修改数据");
      const model = (await database.query<{ protocol: string }>(`SELECT p.protocol FROM model_configs m JOIN providers p ON p.id=m.provider_id
        WHERE m.id::text=$1 AND m.enabled=true AND p.enabled=true AND 'chat'=ANY(m.capabilities) AND m.workflow_config_id IS NULL`, [options.optimizerModelConfigId])).rows[0];
      if (!model || !(CHAT_COMPLETION_PROTOCOLS as readonly string[]).includes(model.protocol)) throw new Error("--optimizer-model 不是目标数据库中已启用、协议受支持的文字扩写模型；未修改数据");
      console.log(JSON.stringify(await installNewCreativeRecipes(postgresPromptRecipeStore(database), options), null, 2));
    } finally { await database.end(); }
  }
}
