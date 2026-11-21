import type { ConversationEntrypoint } from "../../shared/image-conversation-contracts";
import { IMAGE_CONVERSATION_PLANNER_MODEL_ID, plannerProtocols } from "../../shared/image-conversation-planner-policy";
import type { Database } from "./db";
import { PromptOptimizationError } from "./prompt-safety";
import { resolveToolExecution } from "./tool-configuration";

export type PlannerModel = {
    id: string;
    model_id: string;
    provider_id: string;
    capabilities: string[];
    base_url: string;
    protocol: string;
    encrypted_credentials: string | null;
    model_enabled: boolean;
    provider_enabled: boolean;
    workflow_config_id: string | null;
    model_updated_at: string;
    provider_updated_at: string;
    credit_cost: number;
    rmb_cost: string;
};

export function resolveConversationPlannerBinding(db: Pick<Database, "query">, entrypoint: ConversationEntrypoint) {
    return resolveToolExecution(db, { operationType: "chat", toolKey: entrypoint === "canvas" ? "canvas-chat" : "gpt-chat" });
}

function invalid(code: string, message: string, status: number): never {
    throw new PromptOptimizationError(code, message, status);
}

export async function readPlannerModel(db: Pick<Database, "query">, modelConfigId: string): Promise<PlannerModel> {
    const result = await db.query<PlannerModel>(
        `SELECT m.id,m.model_id,m.provider_id,m.capabilities,m.credit_cost,m.rmb_cost,m.enabled AS model_enabled,m.workflow_config_id,
    m.updated_at::text AS model_updated_at,p.base_url,p.protocol,p.encrypted_credentials,p.enabled AS provider_enabled,p.updated_at::text AS provider_updated_at
    FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.id=$1`,
        [modelConfigId],
    );
    const model = result.rows[0];
    if (
        !model ||
        !model.model_enabled ||
        !model.provider_enabled ||
        model.workflow_config_id ||
        model.model_id !== IMAGE_CONVERSATION_PLANNER_MODEL_ID ||
        !model.capabilities.includes("chat")
    )
        invalid(
            "PLANNER_MODEL_NOT_CONFIGURED",
            "会话规划必须绑定已启用的 GPT-6.2 Sol 对话模型，不会回退到其他模型",
            503,
        );
    if (!model.capabilities.includes("vision"))
        invalid("CHAT_VISION_REQUIRED", "会话规划模型必须具备图文理解能力，未发送模型请求", 422);
    if (!plannerProtocols.includes(model.protocol))
        invalid("PROTOCOL_NOT_SUPPORTED", "会话规划模型协议不受支持，未发送模型请求", 422);
    let url: URL;
    try {
        url = new URL(model.base_url);
    } catch {
        return invalid("PROVIDER_NOT_CONFIGURED", "会话规划模型服务地址无效", 503);
    }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
        invalid("PROVIDER_NOT_CONFIGURED", "会话规划模型服务地址无效", 503);
    return model;
}
