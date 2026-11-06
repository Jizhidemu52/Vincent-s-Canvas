import { AGENT_DOCUMENT_LIMITS, type AgentDocument, type AgentDocumentCatalogEntry, type AgentDocumentReadInput, type DesignRequirements } from "../../../shared/image-agent-documents";

const limits = AGENT_DOCUMENT_LIMITS;
const validId = (value: unknown): value is string => typeof value === "string" && value.length <= 300 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
function fail(message: string): never { throw new Error(message); }
const unique = (values: readonly string[]) => new Set(values).size === values.length;

/** Catalogs contain IDs only, never source bytes, arbitrary URLs or filesystem paths. */
export function agentDocumentCatalog(documents: readonly AgentDocument[]): AgentDocumentCatalogEntry[] {
    if (documents.length > limits.files) fail("会话文件数量超过限制");
    const ids = new Set<string>();
    const register = (id: string) => { if (!validId(id) || ids.has(id)) fail("文件或内容标识无效或重复"); ids.add(id); };
    return documents.map(document => {
        register(document.id);
        if (!document.name || document.name.length > 200 || !["pdf", "docx", "workbook", "text"].includes(document.kind)) fail("文件目录无效");
        if (document.sections.length > limits.sections || document.figures.length > limits.figures) fail("文件章节或图片数量超过限制");
        if (document.sections.reduce((total, section) => total + section.text.length, 0) > limits.textCharacters) fail("文件正文超过限制");
        const sections = new Map(document.sections.map(section => [section.id, section]));
        for (const section of document.sections) register(section.id);
        for (const figure of document.figures) {
            register(figure.id);
            if (!sections.get(figure.sectionId)?.figureIds.includes(figure.id)) fail("文件图片与章节不匹配");
        }
        const figures = new Map(document.figures.map(figure => [figure.id, figure]));
        for (const section of document.sections) {
            if (!unique(section.figureIds) || section.figureIds.some(id => figures.get(id)?.sectionId !== section.id)) fail("文件章节引用了不属于本节的图片");
        }
        return { id: document.id, name: document.name, kind: document.kind, sectionCount: document.sections.length, figureCount: document.figures.length,
            sections: document.sections.map(section => ({ id: section.id, figureIds: [...section.figureIds] })) };
    });
}

/** A fair, explicitly partial preview. Full sections remain available through read_document. */
export function agentDocumentContext(documents: readonly AgentDocument[]): string {
    agentDocumentCatalog(documents);
    if (!documents.length) return "";
    const perDocument = Math.floor((limits.contextCharacters - 100) / documents.length);
    return documents.map(document => {
        const header = `[文件 ${document.id}：${document.name}；${document.sections.length} 节，${document.figures.length} 图]\n`;
        const warning = document.warnings.length ? `解析限制：${document.warnings.join("；")}\n` : "";
        const marker = "\n[以上仅为文件节选；未展示的章节和图片可通过 read_document 按节或关键词查阅。]";
        const body = document.sections.map(section => `[${section.title}；章节ID ${section.id}]\n${section.text}${section.figureIds.length ? `\n文件图：${section.figureIds.join("、")}` : ""}`).join("\n\n");
        return (header + warning + body).slice(0, Math.max(0, perDocument - marker.length)) + marker;
    }).join("\n\n");
}

export function readAgentDocument(documents: readonly AgentDocument[], value: unknown) {
    agentDocumentCatalog(documents);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["document_id", "section_start", "section_count", "character_start", "query"].includes(key))) fail("文件查阅参数无效");
    const input = value as AgentDocumentReadInput;
    const document = documents.find(item => item.id === input.document_id);
    if (!document) fail("只能查阅本会话已上传的文件");
    const start = input.section_start ?? 1, count = input.section_count ?? (input.character_start === undefined ? limits.lookupSections : 1);
    if (!Number.isInteger(start) || start < 1 || start > Math.max(1, document.sections.length) || !Number.isInteger(count) || count < 1 || count > limits.lookupSections) fail("文件查阅章节范围无效");
    if (input.query !== undefined && (typeof input.query !== "string" || !input.query.trim() || input.query.length > 1000)) fail("文件查阅关键词无效");
    if (input.character_start !== undefined && (!Number.isInteger(input.character_start) || input.character_start < 1 || input.character_start > Math.max(1, document.sections[start - 1]?.text.length || 0) || count !== 1 || input.query !== undefined)) fail("字符续读位置无效；只能指定一个章节，且不能同时按关键词查找");
    const query = input.query?.trim();
    const matcher = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu") : undefined;
    const matches = document.sections.map((section, index) => ({ section, index })).slice(start - 1).filter(({ section }) => !matcher || matcher.test(section.title) || matcher.test(section.text));
    const sections = matches.slice(0, count);
    const figureIds = new Set(sections.flatMap(({ section }) => section.figureIds));
    const figures = document.figures.filter(figure => figureIds.has(figure.id)).slice(0, 3);
    const header = `[文件 ${document.id}：${document.name}]\n`;
    const trailer = `\n[本次展示 ${sections.length} 节的正文范围、${figures.length} 张本地可用图；匹配章节共 ${matches.length} 节，未展示内容仍保留，不能视为已读。]`;
    const cursor = (index: number, characterStart?: number): AgentDocumentReadInput => ({ document_id: document.id, section_start: index + 1, section_count: 1, ...(characterStart !== undefined ? { character_start: characterStart } : {}) });
    const nextSections: AgentDocumentReadInput | undefined = matches.length > sections.length ? { document_id: document.id, section_start: matches[sections.length]!.index + 1, section_count: count, ...(query ? { query } : {}) } : undefined;
    const nextSectionsText = nextSections ? `\n下一批章节：read_document(${JSON.stringify(nextSections)})` : "";
    const entries = sections.map(({ section, index }) => {
        const hit = matcher ? section.text.search(matcher) : -1;
        const offset = input.character_start !== undefined ? input.character_start - 1 : Math.max(0, hit - 200);
        const imageIds = figures.filter(figure => figure.sectionId === section.id).map(figure => figure.id);
        const imageText = `\n本节文件图 ${section.figureIds.length} 张；本次可用文件图ID：${imageIds.join("、") || "无"}`;
        const prefix = offset ? `\n[本节前文未展示；从头完整查阅：read_document(${JSON.stringify(cursor(index, 1))})]` : "";
        const render = (text: string, end: number, next?: AgentDocumentReadInput) => `[${section.title.slice(0, 200)}；章节ID ${section.id}；第 ${index + 1} 节；字符 ${offset + 1}–${end}/${section.text.length}]${prefix}\n${text}${imageText}${next ? `\n下一段：read_document(${JSON.stringify(next)})` : ""}`;
        // Reserve complete source labels and worst-width cursors before allocating
        // body text. No final slice may silently remove a match or continuation.
        const overhead = render("", limits.textCharacters, cursor(index, limits.textCharacters)).length;
        return { section, index, offset, render, overhead };
    });
    const budget = Math.floor((limits.lookupCharacters - header.length - trailer.length - nextSectionsText.length - entries.reduce((total, entry) => total + entry.overhead, 0) - Math.max(0, entries.length - 1) * 2) / Math.max(1, entries.length));
    if (budget < (query?.length || 0) + 200) fail("文件章节标识超过单次查阅预算，请一次查阅一个章节");
    const continuations: AgentDocumentReadInput[] = [];
    const chunks = entries.map(entry => {
        let end = Math.min(entry.section.text.length, entry.offset + budget);
        if (end < entry.section.text.length && /[\uD800-\uDBFF]/.test(entry.section.text[end - 1] || "") && /[\uDC00-\uDFFF]/.test(entry.section.text[end] || "")) end--;
        const text = entry.section.text.slice(entry.offset, end);
        if (end < entry.section.text.length) continuations.push(cursor(entry.index, end + 1));
        return { sectionId: entry.section.id, sectionNumber: entry.index + 1, characterStart: entry.offset + 1, characterEnd: end, text };
    });
    const body = chunks.length ? chunks.map((chunk, index) => entries[index]!.render(chunk.text, chunk.characterEnd, continuations.find(next => next.section_start === chunk.sectionNumber))).join("\n\n") : "没有找到匹配关键词的章节；不代表文件中不存在未识别的图像内容。";
    if (nextSections) continuations.push(nextSections);
    return { text: header + body + trailer + nextSectionsText, figures, chunks, continuations };
}

/** Validate local tool output against actual persisted documents before rendering or confirming. */
export function parseDesignRequirements(value: unknown, documents: readonly AgentDocument[]): DesignRequirements {
    agentDocumentCatalog(documents);
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("设计需求卡格式无效");
    const data = value as Record<string, unknown>;
    const keys = ["title", "documentIds", "subject", "colors", "materials", "must", "avoid", "unknowns", "referenceFigureIds", "sources"];
    if (Object.keys(data).length !== keys.length || Object.keys(data).some(key => !keys.includes(key)) || JSON.stringify(data).length > 8000) fail("设计需求卡字段无效或超过8000字符");
    const text = (key: string, max: number) => {
        const result = data[key];
        if (typeof result !== "string" || result.length > max) fail("设计需求卡文字无效或超过限制");
        return result as string;
    };
    const list = (key: string, max: number, length: number) => {
        const result = data[key];
        if (!Array.isArray(result) || result.length > length || result.some(item => typeof item !== "string" || !item.trim() || item.length > max)) fail("设计需求卡列表无效或超过限制");
        return [...result as string[]];
    };
    const documentIds = list("documentIds", 300, limits.files), referenceFigureIds = list("referenceFigureIds", 300, limits.figures);
    if (!documentIds.length || !unique(documentIds) || !unique(referenceFigureIds)) fail("设计需求卡文件或图片引用重复或为空");
    const selected = documents.filter(document => documentIds.includes(document.id));
    if (selected.length !== documentIds.length) fail("设计需求卡引用了本会话以外的文件");
    const knownFigures = new Set(selected.flatMap(document => document.figures.map(figure => figure.id)));
    if (referenceFigureIds.some(id => !knownFigures.has(id))) fail("设计需求卡引用了未提供的文件图");
    if (!Array.isArray(data.sources) || data.sources.length > 40) fail("设计需求卡来源无效");
    const sources = data.sources.map(source => {
        if (!source || typeof source !== "object" || Array.isArray(source) || Object.keys(source).length !== 2 || !validId(source.documentId) || !validId(source.sectionId)) fail("设计需求卡来源无效");
        if (!selected.some(document => document.id === source.documentId && document.sections.some(section => section.id === source.sectionId))) fail("设计需求卡来源不属于引用文件");
        return { documentId: source.documentId as string, sectionId: source.sectionId as string };
    });
    return { title: text("title", 200), documentIds, subject: text("subject", 1000), colors: text("colors", 1000), materials: text("materials", 1000),
        must: list("must", 400, 20), avoid: list("avoid", 400, 20), unknowns: list("unknowns", 400, 20), referenceFigureIds, sources };
}
