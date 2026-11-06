import { AGENT_DOCUMENT_LIMITS, type AgentDocument } from "../../../shared/image-agent-documents";

export const MAX_CHAT_ATTACHMENT_TEXT_LENGTH = 80_000;
// This bounds the compatibility preview, never the retained document sections.
export const MAX_WORKBOOK_MODEL_TEXT_LENGTH = 30_000;
const WORKBOOK_TRUNCATION_MARKER = "[Excel \u5de5\u4f5c\u7c3f\u5185\u5bb9\u5df2\u6309\u5de5\u4f5c\u8868\u622a\u65ad]";
export const CHAT_ATTACHMENT_ACCEPT = "image/*,.txt,.md,.csv,.json,.py,.js,.ts,.tsx,.jsx,.html,.css,.xml,.yaml,.yml,.sql,.java,.c,.cpp,.h,.sh,.pdf,.xlsx,.xls,.docx,text/plain,text/markdown,text/csv,application/json,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function openChatAttachmentPicker(input: Pick<HTMLInputElement, "accept" | "click"> | null, imagesOnly = false) {
    if (!input) return;
    input.accept = imagesOnly ? "image/*" : CHAT_ATTACHMENT_ACCEPT;
    input.click();
}

const TEXT_EXTENSIONS = new Set([
    "txt", "md", "csv", "json", "py", "js", "ts", "tsx", "jsx", "html", "css", "xml", "yaml", "yml", "sql", "java", "c", "cpp", "h", "sh",
]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const OFFICE_EXTENSIONS = new Set(["pdf", "xlsx", "xls", "docx"]);

export type ParsedChatAttachment = {
    kind: "image" | "text";
    name: string;
    mimeType: string;
    size: number;
    dataUrl?: string;
    textContent?: string;
    truncated?: boolean;
    document?: AgentDocument;
};

type ParseChatAttachmentOptions = {
    imageToDataUrl?: (file: File) => Promise<string>;
};

export type ChatAttachmentParserKind = "pdf" | "workbook" | "docx";

export function chatAttachmentExtension(name: string) {
    const match = /\.([a-z0-9]+)$/i.exec(name.trim());
    return match?.[1]?.toLowerCase() || "";
}

export function isSupportedChatAttachment(file: Pick<File, "name" | "type">) {
    const extension = chatAttachmentExtension(file.name);
    return IMAGE_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(extension) || OFFICE_EXTENSIONS.has(extension) || file.type.startsWith("image/") || file.type.startsWith("text/");
}

/** Heavy office parsers are loaded only after the user selects a matching file. */
export function chatAttachmentParserKind(file: Pick<File, "name" | "type">): ChatAttachmentParserKind | null {
    const extension = chatAttachmentExtension(file.name);
    if (extension === "pdf" || file.type === "application/pdf") return "pdf";
    if (extension === "xlsx" || extension === "xls") return "workbook";
    if (extension === "docx") return "docx";
    return null;
}

export function truncateChatAttachmentText(value: string) {
    if (value.length <= MAX_CHAT_ATTACHMENT_TEXT_LENGTH) return { text: value, truncated: false };
    const marker = "\n\n[\u9644\u4ef6\u5185\u5bb9\u5df2\u622a\u65ad]\n";
    return { text: `${value.slice(0, MAX_CHAT_ATTACHMENT_TEXT_LENGTH - marker.length)}${marker}`, truncated: true };
}

export function formatPdfText(pages: string[]) {
    return pages
        .map((page, index) => `[\u7b2c ${index + 1} \u9875]\n${page.trim() || "(\u672a\u63d0\u53d6\u5230\u6587\u672c)"}`)
        .join("\n\n");
}

type WorkbookSection = {
    name: string;
    text: string;
};

function formatWorkbookSections(sheets: Array<{ name: string; rows: unknown[][] }>): WorkbookSection[] {
    return sheets
        .map(({ name, rows }) => {
            const tsv = rows
                .filter((row) => row.some((cell) => String(cell ?? "").trim()))
                .map((row) => {
                    // Formatting can extend an Excel sheet to column XFD. Those cells are empty,
                    // but serializing them would add thousands of meaningless tabs to the prompt.
                    let lastValueIndex = row.length - 1;
                    while (lastValueIndex >= 0 && !String(row[lastValueIndex] ?? "").trim()) {
                        lastValueIndex -= 1;
                    }

                    return row
                        .slice(0, lastValueIndex + 1)
                        .map((cell) => String(cell ?? "").replace(/[\t\r\n]+/g, " "))
                        .join("\t");
                })
                .join("\n");
            return { name, text: `[\u5de5\u4f5c\u8868\uff1a${name}]\n${tsv || "(\u7a7a\u8868)"}` };
        });
}

export function formatWorkbookText(sheets: Array<{ name: string; rows: unknown[][] }>) {
    return formatWorkbookSections(sheets).map((section) => section.text).join("\n\n");
}

export function truncateWorkbookText(sheets: Array<{ name: string; rows: unknown[][] }>) {
    const sections = formatWorkbookSections(sheets);
    const completeText = sections.map((section) => section.text).join("\n\n");
    if (completeText.length <= MAX_WORKBOOK_MODEL_TEXT_LENGTH) return completeText;

    // A generic first-N-character cut can hide the later sheets entirely.  Allocate an
    // equal readable sample to each sheet instead, so the model can still see the workbook's
    // structure and the user can ask a follow-up about any sheet.
    const workbookMarker = `\n\n${WORKBOOK_TRUNCATION_MARKER}\n`;
    const sectionMarker = "\n[\u672c\u8868\u5185\u5bb9\u5df2\u622a\u65ad]";
    const separatorLength = Math.max(0, sections.length - 1) * 2;
    const headers = sections.map((section) => `[\u5de5\u4f5c\u8868\uff1a${section.name}]\n`);
    const headersLength = headers.reduce((total, header) => total + header.length, 0);
    const reservedMarkersLength = sections.length * sectionMarker.length;
    const availableContent = Math.max(0, MAX_WORKBOOK_MODEL_TEXT_LENGTH - workbookMarker.length - separatorLength - headersLength - reservedMarkersLength);
    const contentBudget = Math.floor(availableContent / Math.max(1, sections.length));

    const shortened = sections.map((section, index) => {
        const header = headers[index];
        const content = section.text.slice(header.length);
        if (content.length <= contentBudget) return section.text;
        return `${header}${content.slice(0, contentBudget)}${sectionMarker}`;
    });

    return `${shortened.join("\n\n")}${workbookMarker}`;
}

async function readFileAsDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("\u65e0\u6cd5\u8bfb\u53d6\u56fe\u7247\u6587\u4ef6"));
        reader.readAsDataURL(file);
    });
}

export async function parseChatAttachment(file: File, options: ParseChatAttachmentOptions = {}): Promise<ParsedChatAttachment> {
    if (!isSupportedChatAttachment(file)) {
        throw new Error("\u4ec5\u652f\u6301\u56fe\u7247\u3001PDF\u3001Excel\u3001Word\u3001\u6587\u672c\u6216\u4ee3\u7801\u6587\u4ef6");
    }
    if (file.size > AGENT_DOCUMENT_LIMITS.fileBytes) throw new Error("单个附件不能超过 20 MB，请拆分文件后上传");

    const extension = chatAttachmentExtension(file.name);
    if (IMAGE_EXTENSIONS.has(extension) || file.type.startsWith("image/")) {
        return {
            kind: "image",
            name: file.name,
            mimeType: file.type || "image/jpeg",
            size: file.size,
            dataUrl: options.imageToDataUrl ? await options.imageToDataUrl(file) : await readFileAsDataUrl(file),
        };
    }

    const parserKind = chatAttachmentParserKind(file);
    try {
        const { parseAgentDocument, agentDocumentTextPreview } = await import("./agent-document-parser");
        const document = await parseAgentDocument(file, parserKind || "text");
        const preview = agentDocumentTextPreview(document, parserKind === "workbook" ? MAX_WORKBOOK_MODEL_TEXT_LENGTH : MAX_CHAT_ATTACHMENT_TEXT_LENGTH);
        return {
            kind: "text", name: file.name, mimeType: document.mimeType, size: file.size,
            textContent: preview.text, truncated: preview.truncated, document,
        };
    } catch (error) {
        const detail = error instanceof Error ? error.message : "\u672a\u77e5\u89e3\u6790\u9519\u8bef";
        throw new Error(`\u65e0\u6cd5\u89e3\u6790 ${file.name}\uff1a${detail}`);
    }

}
