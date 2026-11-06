/** Employee-owned design documents. Text and media are data, never executable instructions. */
export const AGENT_DOCUMENT_LIMITS = {
    files: 8,
    fileBytes: 20 * 1024 * 1024,
    sections: 200,
    textCharacters: 1_000_000,
    figures: 80,
    previewBytes: 24 * 1024 * 1024,
    contextCharacters: 30_000,
    lookupCharacters: 18_000,
    lookupSections: 3,
} as const;

export type AgentDocumentMedia = {
    name: string;
    mimeType: string;
    dataUrl: string;
    storageKey?: string;
    serverAssetId?: string;
};
export type AgentDocumentFigure = AgentDocumentMedia & {
    id: string;
    label: string;
    sectionId: string;
    width?: number;
    height?: number;
};
export type AgentDocumentSection = {
    id: string;
    title: string;
    text: string;
    figureIds: string[];
};
export type AgentDocument = {
    id: string;
    name: string;
    kind: "pdf" | "docx" | "workbook" | "text";
    mimeType: string;
    bytes: number;
    /** Exact uploaded bytes; never a rendered page or extracted text substitute. */
    source?: AgentDocumentMedia;
    sections: AgentDocumentSection[];
    figures: AgentDocumentFigure[];
    /** Explicit unsupported content / extraction limitations shown in the UI and to the planner. */
    warnings: string[];
};
export type AgentDocumentCatalogEntry = {
    id: string;
    name: string;
    kind: AgentDocument["kind"];
    sectionCount: number;
    figureCount: number;
    /** Bounded manifest; file/section/figure references are checked against this session. */
    sections: Array<{ id: string; figureIds: string[] }>;
};
export type AgentDocumentReadInput = {
    document_id: string;
    /** One-based section, independent of filenames or filesystem paths. */
    section_start?: number;
    section_count?: number;
    /** One-based character cursor for a single section; cannot be combined with query. */
    character_start?: number;
    query?: string;
};
export type DesignRequirements = {
    title: string;
    documentIds: string[];
    subject: string;
    colors: string;
    materials: string;
    must: string[];
    avoid: string[];
    unknowns: string[];
    referenceFigureIds: string[];
    sources: Array<{ documentId: string; sectionId: string }>;
};
export type DesignRequirementCard = DesignRequirements & {
    id: string;
    status: "draft" | "confirmed";
    updatedAt: string;
};

/** Plain visual requirements only. Unknown facts are not compiled as image instructions. */
export function designRequirementsText(card: DesignRequirements): string {
    return [
        card.subject.trim() ? `款式与主体：${card.subject.trim()}` : "",
        card.colors.trim() ? `颜色：${card.colors.trim()}` : "",
        card.materials.trim() ? `材质与工艺：${card.materials.trim()}` : "",
        ...card.must.filter(value => value.trim()).map(value => `必须保留或体现：${value.trim()}`),
        ...card.avoid.filter(value => value.trim()).map(value => `不要：${value.trim()}`),
    ].filter(Boolean).join("\n");
}
