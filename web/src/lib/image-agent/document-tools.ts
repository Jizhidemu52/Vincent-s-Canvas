import type { AgentDocument, AgentDocumentReadInput, DesignRequirementCard, DesignRequirements } from "../../../../shared/image-agent-documents";
import { parseDesignRequirements, readAgentDocument } from "@/lib/agent-documents";
import { validatedCreativeChatCall } from "@/lib/creative-chat";
import type { ToolResponseResult } from "@/services/api/image";

export function confirmedDesignRequirements(card?: DesignRequirementCard): DesignRequirements | undefined {
    if (card?.status !== "confirmed") return;
    const { id: _id, status: _status, updatedAt: _updatedAt, ...requirements } = card;
    return requirements;
}

export function parseAgentDocumentTool(result: ToolResponseResult, documents: AgentDocument[]) {
    const value = validatedCreativeChatCall(result);
    if (!value || !["read_document", "propose_requirements"].includes(value.call.function.name)) return null;
    if (value.call.function.name === "read_document") return { kind: "read" as const, call: value.call, ...readAgentDocument(documents, value.args as AgentDocumentReadInput) };
    return { kind: "requirements" as const, requirements: parseDesignRequirements(value.args, documents) };
}
