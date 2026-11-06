import { AGENT_DOCUMENT_LIMITS, type AgentDocument, type AgentDocumentFigure, type AgentDocumentSection } from "../../../shared/image-agent-documents";
import { createClientUuid } from "./client-uuid";

const documentMimeByExtension: Record<string, string> = {
    pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel",
    csv: "text/csv", md: "text/markdown", markdown: "text/markdown", txt: "text/plain", json: "application/json",
};

export function bytesDataUrl(bytes: Uint8Array, mimeType: string): string {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    return `data:${mimeType};base64,${btoa(binary)}`;
}

export function dataUrlBytes(dataUrl: string): number {
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return Math.floor(base64.length * 3 / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
}

/** Budgets apply to complete retained data, independently of the short chat preview. */
export class AgentDocumentBuilder {
    readonly document: AgentDocument;
    private textCharacters = 0;
    private previewBytes = 0;

    constructor(file: File, kind: AgentDocument["kind"], bytes: Uint8Array) {
        const extension = /\.([a-z0-9]+)$/i.exec(file.name.trim())?.[1]?.toLowerCase() || "";
        // Code sources are delivered as inert text, not browser-supplied executable MIME types.
        const mimeType = documentMimeByExtension[extension] || (kind === "text" ? "text/plain" : file.type) || ({ pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", workbook: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", text: "text/plain" }[kind]);
        this.document = { id: createClientUuid(), name: file.name, kind, mimeType, bytes: file.size,
            source: { name: file.name, mimeType, dataUrl: bytesDataUrl(bytes, mimeType) }, sections: [], figures: [], warnings: [] };
    }

    warn(message: string) {
        if (!this.document.warnings.includes(message)) this.document.warnings.push(message);
    }

    section(title: string, text: string): AgentDocumentSection {
        if (this.document.sections.length >= AGENT_DOCUMENT_LIMITS.sections) throw new Error(`文件分节超过 ${AGENT_DOCUMENT_LIMITS.sections} 节，请拆分后上传；未将残缺正文作为完整文件保存`);
        this.textCharacters += text.length;
        if (this.textCharacters > AGENT_DOCUMENT_LIMITS.textCharacters) throw new Error(`文件完整正文超过 ${AGENT_DOCUMENT_LIMITS.textCharacters} 字符，请拆分后上传；未截断保存`);
        const section = { id: `${this.document.id}:section:${this.document.sections.length + 1}`, title, text, figureIds: [] as string[] };
        this.document.sections.push(section);
        return section;
    }

    canAddFigure() {
        if (this.document.figures.length < AGENT_DOCUMENT_LIMITS.figures && this.previewBytes < AGENT_DOCUMENT_LIMITS.previewBytes) return true;
        this.warn("文件预览达到 80 张或 24 MB 上限，未包含的图像仍保留在原文件中；请拆分文件补充查阅，不能视为已完整看过全部图像。");
        return false;
    }

    figure(section: AgentDocumentSection, media: Omit<AgentDocumentFigure, "id" | "sectionId">) {
        if (!this.canAddFigure()) return;
        const bytes = dataUrlBytes(media.dataUrl);
        if (this.previewBytes + bytes > AGENT_DOCUMENT_LIMITS.previewBytes) {
            this.warn(`“${media.label}”超出剩余 24 MB 预览预算，未加入预览；原始图像保留在原文件中，请拆分文件补充。`);
            return;
        }
        const figure = { ...media, id: `${this.document.id}:figure:${this.document.figures.length + 1}`, sectionId: section.id };
        this.previewBytes += bytes;
        this.document.figures.push(figure);
        section.figureIds.push(figure.id);
        return figure;
    }
}

/** Read package metadata with fflate, without inflating every entry into memory. */
async function checkOfficePackage(bytes: Uint8Array) {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return;
    const { unzipSync } = await import("fflate");
    let expanded = 0, entries = 0;
    unzipSync(bytes, { filter: file => {
        expanded += file.originalSize;
        if (++entries > 10_000 || expanded > 100 * 1024 * 1024) throw new Error("Office 文件解压内容超过安全预算（100 MB / 10000 项），请拆分文件后上传");
        return false;
    } });
}

export async function parseAgentDocument(file: File, kind: AgentDocument["kind"]): Promise<AgentDocument> {
    if (file.size > AGENT_DOCUMENT_LIMITS.fileBytes) throw new Error("单个文件不能超过 20 MB，请拆分文件后上传");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (kind === "docx" || kind === "workbook") await checkOfficePackage(bytes);
    const builder = new AgentDocumentBuilder(file, kind, bytes);
    if (kind === "pdf") await (await import("./agent-document-parser-pdf")).parsePdfDocument(bytes, builder);
    else if (kind === "docx") await (await import("./agent-document-parser-docx")).parseWordDocument(bytes, builder);
    else if (kind === "workbook") await (await import("./agent-document-parser-workbook")).parseWorkbookDocument(bytes, builder);
    else {
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { throw new Error("文本文件必须使用有效的 UTF-8 编码，请转换编码后上传"); }
        // Match the asset endpoint before a seemingly valid attachment can break cloud saving.
        if (text.includes("\0") || /^\s*(?:<!doctype\s+html|<html\b|<svg\b|<script\b|<\?xml\b)/i.test(text)) throw new Error("不允许上传可执行网页、SVG、XML 或含空字符的文本文件");
        if (builder.document.mimeType === "application/json") {
            try { JSON.parse(text); } catch { throw new Error("JSON 文件内容无效"); }
        }
        if (text.length > AGENT_DOCUMENT_LIMITS.textCharacters) throw new Error(`文件完整正文超过 ${AGENT_DOCUMENT_LIMITS.textCharacters} 字符，请拆分后上传；未截断保存`);
        if (!text.trim()) throw new Error("文件没有可读取的正文");
        for (let offset = 0; offset < text.length; offset += 10_000) builder.section(`正文 ${Math.floor(offset / 10_000) + 1}`, text.slice(offset, offset + 10_000));
    }
    if (!builder.document.sections.length) throw new Error("文件没有可读取的正文或图像页面");
    return builder.document;
}

/** Compatibility preview only. The complete sections remain available for explicit lookup. */
export function agentDocumentTextPreview(document: AgentDocument, limit: number): { text: string; truncated: boolean } {
    const sections = document.sections.map(section => `[${section.title}]\n${section.text}`);
    const complete = sections.join("\n\n");
    if (complete.length <= limit) return { text: complete, truncated: false };
    const marker = "\n\n[此处仅为附件摘要；完整分节和原文件已保存，可按页、工作表或关键词查阅。]";
    const budget = Math.max(0, Math.floor((limit - marker.length - sections.length * 2) / sections.length));
    return { text: sections.map(section => section.length <= budget ? section : `${section.slice(0, Math.max(0, budget - 9))}\n[本节摘要]`).join("\n\n") + marker, truncated: true };
}
