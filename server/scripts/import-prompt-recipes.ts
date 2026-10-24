import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDatabase } from "../src/db";
import { sqlitePromptRecipeStore } from "../src/demo-prompt-recipes";
import { postgresPromptRecipeStore } from "../src/prompt-recipe-postgres";
import { importPromptRecipes, parsePromptRecipeDocument } from "../src/prompt-recipe-import";

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  file: { type: "string" }, sqlite: { type: "string" }, actor: { type: "string", default: "administrator-import" },
  model: { type: "string" }, activate: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false },
} });
if (!values.file) throw new Error("请通过 --file 指定用户提供的配方文档；使用 --sqlite 指定本机数据库，或配置 DATABASE_URL");
const source = await readFile(resolve(values.file), "utf8");
if (values["dry-run"]) {
  console.log(JSON.stringify({ recipes: parsePromptRecipeDocument(source).map(entry => ({ key: entry.key, name: entry.settings.name, characters: entry.content.systemPrompt.length })) }, null, 2));
} else if (values.sqlite) {
  const database = sqlitePromptRecipeStore(resolve(values.sqlite));
  try { console.log(JSON.stringify(await importPromptRecipes(database.store, source, { actorId: values.actor!, modelConfigId: values.model, activate: values.activate }), null, 2)); }
  finally { database.close(); }
} else {
  if (!process.env.DATABASE_URL) throw new Error("未配置 DATABASE_URL，未导入任何数据");
  const database = createDatabase(process.env.DATABASE_URL);
  try { console.log(JSON.stringify(await importPromptRecipes(postgresPromptRecipeStore(database), source, { actorId: values.actor!, modelConfigId: values.model, activate: values.activate }), null, 2)); }
  finally { await database.end(); }
}
