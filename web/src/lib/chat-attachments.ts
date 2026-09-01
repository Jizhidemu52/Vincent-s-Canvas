import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const MAX_CHAT_ATTACHMENT_TEXT_LENGTH = 80_000;
// Workbooks are structured but can be extremely verbose. Keeping their model context smaller
// avoids provider-side extended thinking consuming the whole response budget before answering.
export const MAX_WORKBOOK_MODEL_TEXT_LENGTH = 8_000;
const WORKBOOK_TRUNCATION_MARKER = "[Excel \u5de5\u4f5c\u7c3f\u5185\u5bb9\u5df2\u6309\u5de5\u4f5c\u8868\u622a\u65ad]";
export const CHAT_ATTACHMENT_ACCEPT = "image/*,.txt,.md,.csv,.json,.py,.js,.ts,.tsx,.jsx,.html,.css,.xml,.yaml,.yml,.sql,.java,.c,.cpp,.h,.sh,.pdf,.xlsx,.xls,.docx,text/plain,text/markdown,text/csv,application/json,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
};

type ParseChatAttachmentOptions = {
    imageToDataUrl?: (file: File) => Promise<string>;
};

export function chatAttachmentExtension(name: string) {
    const match = /\.([a-z0-9]+)$/i.exec(name.trim());
    return match?.[1]?.toLowerCase() || "";
}

export function isSupportedChatAttachment(file: Pick<File, "name" | "type">) {
    const extension = chatAttachmentExtension(file.name);
    return IMAGE_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(extension) || OFFICE_EXTENSIONS.has(extension) || file.type.startsWith("image/") || file.type.startsWith("text/");
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

async function extractPdfText(file: File) {
    const task = getDocument({ data: new Uint8Array(await file.arrayBuffer()), useWorkerFetch: false });
    const pdf = await task.promise;
    try {
        const pages = await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => {
            const page = await pdf.getPage(index + 1);
            const content = await page.getTextContent();
            return content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
        }));
        return formatPdfText(pages);
    } finally {
        pdf.cleanup();
        task.destroy();
    }
}

async function extractWorkbookText(file: File) {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
    return truncateWorkbookText(workbook.SheetNames.map((name) => ({
        name,
        rows: XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, raw: false, defval: "" }),
    })));
}

async function extractDocxText(file: File) {
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value.trim();
}

export async function parseChatAttachment(file: File, options: ParseChatAttachmentOptions = {}): Promise<ParsedChatAttachment> {
    if (!isSupportedChatAttachment(file)) {
        throw new Error("\u4ec5\u652f\u6301\u56fe\u7247\u3001PDF\u3001Excel\u3001Word\u3001\u6587\u672c\u6216\u4ee3\u7801\u6587\u4ef6");
    }

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

    let extractedText: string;
    try {
        if (extension === "pdf" || file.type === "application/pdf") extractedText = await extractPdfText(file);
        else if (extension === "xlsx" || extension === "xls") extractedText = await extractWorkbookText(file);
        else if (extension === "docx") extractedText = await extractDocxText(file);
        else extractedText = await file.text();
    } catch (error) {
        const detail = error instanceof Error ? error.message : "\u672a\u77e5\u89e3\u6790\u9519\u8bef";
        throw new Error(`\u65e0\u6cd5\u89e3\u6790 ${file.name}\uff1a${detail}`);
    }

    if (!extractedText.trim()) throw new Error(`${file.name} \u6ca1\u6709\u53ef\u4f9b\u5bf9\u8bdd\u6a21\u578b\u9605\u8bfb\u7684\u6587\u672c\u5185\u5bb9`);
    const truncated = truncateChatAttachmentText(extractedText);
    const wasWorkbookTruncated = (extension === "xlsx" || extension === "xls") && extractedText.includes(WORKBOOK_TRUNCATION_MARKER);
    return {
        kind: "text",
        name: file.name,
        mimeType: file.type || "text/plain",
        size: file.size,
        textContent: truncated.text,
        truncated: truncated.truncated || wasWorkbookTruncated,
    };
}
