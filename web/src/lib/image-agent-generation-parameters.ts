import type { AgentDocumentCatalogEntry, DesignRequirements } from "../../../shared/image-agent-documents";

export type ImageAgentGenerationOptions = {
    imageAgentProfile?: "creative-chat" | "canvas-assistant";
    imageAgentRequirements?: DesignRequirements;
    imageAgentDocumentCatalog?: AgentDocumentCatalogEntry[];
};

/** Snapshot only confirmed client requirements; the server validates every manifest reference. */
export function imageAgentGenerationParameters(options?: ImageAgentGenerationOptions) {
    const requirements = options?.imageAgentRequirements, catalog = options?.imageAgentDocumentCatalog;
    if ((requirements !== undefined || catalog !== undefined) && (!options?.imageAgentProfile || !requirements || !catalog?.length)) {
        throw new Error("已确认文件需求与本会话目录必须一起提交给图片助手");
    }
    return options?.imageAgentProfile ? {
        imageAgentProfile: options.imageAgentProfile,
        ...(requirements && catalog ? { designRequirements: structuredClone(requirements), designDocumentCatalog: structuredClone(catalog) } : {}),
    } : {};
}
