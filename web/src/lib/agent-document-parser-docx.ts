import { bytesDataUrl, type AgentDocumentBuilder } from "./agent-document-parser";

/** Mammoth's parsed document tree, not a hand-written OOXML parser. */
type WordNode = {
    type: string;
    value?: string;
    styleName?: string | null;
    styleId?: string | null;
    children?: WordNode[];
    body?: WordNode[];
    altText?: string;
    contentType?: string;
    readAsArrayBuffer?: () => Promise<ArrayBuffer>;
    notes?: { _notes?: Record<string, WordNode> };
    comments?: WordNode[];
};
type EmbeddedFigure = { node: WordNode; label: string };
const safeImages = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");

export async function parseWordDocument(bytes: Uint8Array, builder: AgentDocumentBuilder) {
    const mammoth = (await import("mammoth")).default;
    let root: WordNode | undefined;
    // Both forms share the same exact bytes. Mammoth's browser build consumes
    // arrayBuffer; its Node build consumes buffer (also accepts Uint8Array).
    const input = { arrayBuffer: bytes.buffer as ArrayBuffer, buffer: bytes } as Parameters<typeof mammoth.convertToHtml>[0];
    const converted = await mammoth.convertToHtml(input, {
        externalFileAccess: false,
        includeEmbeddedStyleMap: false,
        transformDocument: (document: WordNode) => { root = document; return document; },
        // Extraction below associates each original image with its actual block.
        // Never inject converted HTML into the application or load its links.
        convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
    });
    for (const message of converted.messages) builder.warn(`Word 解析提示：${message.message}`);
    if (!root) throw new Error("Word 正文无法解析");
    builder.warn("Word 按正文段落和表格读取，不保留原分页与浮动图像位置；页眉页脚、未支持的图形和修订内容请对照原文件核实。不会读取文件中的外链。");

    let title = "Word 正文", blocks: string[] = [], pending: EmbeddedFigure[] = [], imageCount = 0, paragraph = 0;
    const textOf = (node: WordNode): string => {
        if (node.type === "text") return node.value || "";
        if (node.type === "tab") return "\t";
        if (node.type === "break") return "\n";
        if (node.type === "image") {
            const label = `文件图${++imageCount}`;
            pending.push({ node, label });
            return `[${label}${node.altText ? `：${node.altText}` : ""}]`;
        }
        if (node.type === "table") {
            const rows = (node.children || []).map(row => (row.children || []).map(item => cell(textOf(item).trim())));
            const columns = Math.max(0, ...rows.map(row => row.length));
            if (!columns) return "";
            return [`| ${Array.from({ length: columns }, (_, index) => `列 ${index + 1}`).join(" | ")} |`, `| ${Array(columns).fill("---").join(" | ")} |`, ...rows.map(row => `| ${Array.from({ length: columns }, (_, index) => row[index] || "").join(" | ")} |`)].join("\n");
        }
        const text = (node.children || node.body || []).map(textOf).join("");
        return node.type === "paragraph" ? text + "\n" : text;
    };
    const flush = async () => {
        if (!blocks.length && !pending.length) return;
        const section = builder.section(title, blocks.join("\n\n"));
        for (const { node, label } of pending) {
            if (!builder.canAddFigure()) break;
            if (!safeImages.has(node.contentType || "") || !node.readAsArrayBuffer) {
                builder.warn(`${label} 的内嵌格式 ${node.contentType || "未知"} 不能安全预览，原文件已保留；请另附 PNG/JPEG 图片。`);
                continue;
            }
            try {
                const data = new Uint8Array(await node.readAsArrayBuffer());
                builder.figure(section, { name: `${builder.document.name}-${label}`, label, mimeType: node.contentType!, dataUrl: bytesDataUrl(data, node.contentType!) });
            } catch (error) {
                builder.warn(`${label} 未能读取（外部文件/外链访问保持禁用）：${error instanceof Error ? error.message.slice(0, 240) : "图片读取失败"}。`);
            }
        }
        blocks = []; pending = [];
    };
    const append = async (nodes: WordNode[]) => {
        for (const node of nodes) {
            if (/^(heading|title|标题|章)/i.test(node.styleName || node.styleId || "")) {
                await flush();
                title = (node.children || []).map(item => item.type === "text" ? item.value || "" : (item.children || []).filter(child => child.type === "text").map(child => child.value || "").join("")).join("").trim() || "Word 标题";
            } else if (blocks.join("\n\n").length >= 10_000) {
                await flush();
                title = `${title.replace(/（续）$/, "")}（续）`;
            }
            const text = textOf(node).trim();
            if (text) blocks.push(`段 ${++paragraph}：${text}`);
        }
    };
    await append(root.children || []);
    await flush();
    for (const [key, note] of Object.entries(root.notes?._notes || {})) {
        title = `Word 注释 ${key}`; await append(note.body || []); await flush();
    }
    for (const [index, comment] of (root.comments || []).entries()) {
        title = `Word 批注 ${index + 1}`; await append(comment.body || []); await flush();
    }
}
