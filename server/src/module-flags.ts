import type { Database } from "./db";
import { moduleDefinitions, resolveToolKey, type ModuleKey } from "../../shared/feature-catalog";

export { moduleKeys, type ModuleKey } from "../../shared/feature-catalog";

export function moduleForOperation(operationType: string, parameters: Record<string, unknown> = {}): ModuleKey | null {
  return resolveToolKey(operationType, typeof parameters.tool === "string" ? parameters.tool : undefined) ?? null;
}

export async function isModuleEnabled(db: Pick<Database, "query">, key: ModuleKey): Promise<boolean> {
  const result = await db.query<{ enabled: boolean }>("SELECT enabled FROM module_flags WHERE module_key=$1", [key]);
  if (result.rows[0]?.enabled !== true) return false;
  const parent = moduleDefinitions.find((item) => item.moduleKey === key)?.parent;
  return parent ? isModuleEnabled(db, parent) : true;
}

export class ModuleDisabledError extends Error {
  readonly code = "MODULE_DISABLED";
  readonly status = 403;
  constructor(public readonly moduleKey: ModuleKey) { super("该功能模块已由超级管理员关闭"); }
}

export async function assertModuleEnabled(db: Pick<Database, "query">, key: ModuleKey | null) {
  if (key && !(await isModuleEnabled(db, key))) throw new ModuleDisabledError(key);
}
