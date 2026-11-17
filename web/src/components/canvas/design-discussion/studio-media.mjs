import { AGENT_DOCUMENT_LIMITS } from "../../../../../shared/image-agent-documents.ts";
import { createClientUuid } from "../../../lib/client-uuid.ts";

export const DESIGN_MATERIAL_MAX_BYTES = AGENT_DOCUMENT_LIMITS.fileBytes;

export async function readImageFiles(files) {
    if (files.length > 20) throw new Error("一次最多放入 20 张图片，请分批添加。");
    for (const file of files) if (!/^image\/(png|jpeg|webp)$/.test(file.type) || !file.size || file.size > 8 * 1024 * 1024) throw new Error(`“${file.name}”须为 8 MB 内的 PNG、JPG 或 WebP；本批未添加。`);
    return Promise.all(files.map(file => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ id: createClientUuid(), title: file.name, image: reader.result, kind: "reference", origin: "upload" });
        reader.onerror = () => reject(new Error(`“${file.name}”读取失败。`));
        reader.readAsDataURL(file);
    })));
}

export async function readDesignMaterial(file) {
    if (!file.size) throw new Error("资料文件为空，请选择有效的 PDF 或文档。");
    if (file.size > DESIGN_MATERIAL_MAX_BYTES) throw new Error("单个 PDF 或资料文件不能超过 20 MB，请拆分后添加；本次未读取或上传。");
    const extension = file.name.split(".").at(-1)?.toLowerCase();
    const kind = extension === "pdf" ? "pdf" : extension === "docx" ? "docx" : ["xlsx", "xls"].includes(extension) ? "workbook" : ["txt", "md", "csv"].includes(extension) ? "text" : null;
    if (!kind) throw new Error("资料支持 PDF、DOCX、XLSX、XLS、TXT、MD、CSV。");
    const { parseAgentDocument } = await import("../../../lib/agent-document-parser.ts");
    const document = await parseAgentDocument(file, kind);
    const text = document.sections.map(section => `[${section.title}]\n${section.text}`).join("\n\n");
    if (text.length > 12000) throw new Error("这份资料正文超过 12000 字，请拆分为本次需要的部分；没有截断或声称已经读完。");
    return { ...document, text };
}
