import { moduleDefinitions, toolDefinitions } from "../../../shared/feature-catalog";
import { DEFAULT_CHAT_MODEL_TOOL_KEY } from "../chat-model-policy";
import type { Database } from "../db";
import type { ToolConfiguration } from "../tool-configuration";

type ProviderRow = { id: string; name: string; protocol: string; enabled: boolean; hasCredentials: boolean; baseUrl: string };
type ModelRow = {
    id: string; publicNumber: number | null; providerId: string; workflowConfigId: string | null; replacementModelConfigId: string | null;
    name: string; modelId: string; capabilities: string[]; creditCost: number; rmbCost: number; concurrencyLimit: number; enabled: boolean;
};
type RecipeRow = {
    key: string; name: string | null; enabled: boolean | null; modelConfigId: string | null; failurePolicy: string | null;
    currentVersionId: string | null; currentVersion: number | null;
};

const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
function endpointOrigin(value: string): string | null {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
    } catch { return null; }
}

/** A diffable configuration snapshot, not a backup or an import payload. */
export async function readConfigurationExport(db: Database) {
    const client = await db.connect();
    try {
        // One MVCC snapshot prevents a concurrent administrator edit from mixing
        // old bindings with new model/recipe settings. The database forbids writes.
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const providers = (await client.query<ProviderRow>(`SELECT id,name,protocol,enabled,
            (encrypted_credentials IS NOT NULL) AS "hasCredentials",base_url AS "baseUrl" FROM providers`)).rows;
        const models = (await client.query<ModelRow>(`SELECT id,public_number AS "publicNumber",provider_id AS "providerId",
            workflow_config_id AS "workflowConfigId",replacement_model_config_id AS "replacementModelConfigId",name,model_id AS "modelId",
            capabilities,credit_cost AS "creditCost",rmb_cost::float8 AS "rmbCost",concurrency_limit AS "concurrencyLimit",enabled FROM model_configs`)).rows;
        const tools = (await client.query<ToolConfiguration>(`SELECT tool_key AS "toolKey",model_config_id AS "modelConfigId",enabled,
            credit_cost_override AS "creditCostOverride",rmb_cost_override::float8 AS "rmbCostOverride",
            configuration_version AS "configurationVersion",allow_raw_prompt AS "allowRawPrompt" FROM tool_api_configurations`)).rows;
        const modules = (await client.query<{ moduleKey: string; enabled: boolean }>(`SELECT module_key AS "moduleKey",enabled FROM module_flags`)).rows;
        // Never load settings/content wholesale: future private fields stay private.
        const recipes = (await client.query<RecipeRow>(`SELECT r.key,r.settings->>'name' AS name,(r.settings->>'enabled')::boolean AS enabled,
            r.settings->>'modelConfigId' AS "modelConfigId",r.settings->>'failurePolicy' AS "failurePolicy",
            r.current_version_id AS "currentVersionId",v.version AS "currentVersion"
            FROM prompt_recipes r LEFT JOIN prompt_recipe_versions v ON v.id=r.current_version_id AND v.recipe_key=r.key`)).rows;
        const defaultChatModelId = tools.find(tool => tool.toolKey === DEFAULT_CHAT_MODEL_TOOL_KEY)?.modelConfigId ?? null;
        const snapshot = {
            schemaVersion: 1,
            providers: providers.map(row => ({
                id: row.id, name: row.name, protocol: row.protocol, enabled: row.enabled, hasCredentials: row.hasCredentials,
                // Credentials may appear in userinfo, paths, queries or fragments.
                // Only an HTTP(S) origin is exportable; malformed input stays null.
                endpointOrigin: endpointOrigin(row.baseUrl),
            })).sort((left, right) => compare(left.id, right.id)),
            models: models.map(row => ({
                id: row.id, publicNumber: row.publicNumber, providerId: row.providerId, workflowConfigId: row.workflowConfigId,
                replacementModelConfigId: row.replacementModelConfigId, name: row.name, modelId: row.modelId,
                capabilities: [...row.capabilities].sort(), creditCost: row.creditCost, rmbCost: row.rmbCost,
                concurrencyLimit: row.concurrencyLimit, enabled: row.enabled,
            })).sort((left, right) => compare(left.id, right.id)),
            toolConfigurations: toolDefinitions.map(definition => {
                const row = tools.find(tool => tool.toolKey === definition.toolKey);
                return {
                    toolKey: definition.toolKey, label: definition.label, group: definition.group, parent: definition.parent,
                    operationType: definition.operationType, operations: [...definition.operations].sort(), capabilities: [...definition.capabilities].sort(),
                    configured: Boolean(row), modelConfigId: row?.modelConfigId ?? null,
                    effectiveModelConfigId: definition.toolKey === "canvas-chat" ? defaultChatModelId : row?.modelConfigId ?? null,
                    enabled: row?.enabled ?? true, creditCostOverride: row?.creditCostOverride ?? null, rmbCostOverride: row?.rmbCostOverride ?? null,
                    configurationVersion: row?.configurationVersion ?? 0, allowRawPrompt: row?.allowRawPrompt ?? false,
                };
            }).sort((left, right) => compare(left.toolKey, right.toolKey)),
            modules: moduleDefinitions.map(definition => {
                const row = modules.find(module => module.moduleKey === definition.moduleKey);
                return {
                    moduleKey: definition.moduleKey, label: definition.label, kind: definition.kind, parent: definition.parent,
                    enabled: row?.enabled ?? false, configured: Boolean(row),
                };
            }).sort((left, right) => compare(left.moduleKey, right.moduleKey)),
            promptRecipes: recipes.map(row => ({
                key: row.key, name: row.name, enabled: row.enabled === true, modelConfigId: row.modelConfigId, failurePolicy: row.failurePolicy,
                currentVersionId: row.currentVersionId, currentVersion: row.currentVersion,
                status: row.enabled !== true ? "disabled" : row.currentVersion === null ? "unconfigured" : "active",
            })).sort((left, right) => compare(left.key, right.key)),
        };
        await client.query("COMMIT");
        return snapshot;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally { client.release(); }
}
