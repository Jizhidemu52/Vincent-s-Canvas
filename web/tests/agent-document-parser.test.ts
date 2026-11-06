import { expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { parseChatAttachment } from "../src/lib/chat-attachments";
import { AGENT_DOCUMENT_LIMITS } from "../../shared/image-agent-documents";
import { wordDocumentFixture } from "./fixtures/agent-document-fixtures";

const sourceBytes = (url: string) => new Uint8Array(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));

test("HTTP document uploads use secure random UUIDs without requiring crypto.randomUUID", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
    try {
        const first = (await parseChatAttachment(new File(["红色开衫"], "需求.txt", { type: "text/plain" }))).document!;
        const second = (await parseChatAttachment(new File(["不要口袋"], "修改.txt", { type: "text/plain" }))).document!;
        expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        expect(first.id).not.toBe(second.id);
        expect(first.sections[0]!.id).toStartWith(`${first.id}:section:`);
        expect(sourceBytes(first.source!.dataUrl)).toEqual(new TextEncoder().encode("红色开衫"));
    } finally {
        if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
        else Reflect.deleteProperty(crypto, "randomUUID");
    }
});

test.each([
    { name: "需求.csv", supplied: "application/vnd.ms-excel", expected: "text/csv", body: "颜色,红色\r\n材质,羊毛" },
    { name: "需求.md", supplied: "application/octet-stream", expected: "text/markdown", body: "# 需求\r\n禁止口袋" },
    { name: "需求.ts", supplied: "application/typescript", expected: "text/plain", body: 'const requirement = "禁止口袋";' },
    { name: "需求.py", supplied: "text/x-python", expected: "text/plain", body: 'requirement = "禁止口袋"' },
])("$name keeps its original bytes with extension-based MIME despite browser mislabeling", async ({ name, supplied, expected, body }) => {
    const original = new TextEncoder().encode(body);
    const document = (await parseChatAttachment(new File([original], name, { type: supplied }))).document!;
    expect(document.mimeType).toBe(expected);
    expect(document.source!.mimeType).toBe(expected);
    expect(sourceBytes(document.source!.dataUrl)).toEqual(original);
});

test.each([
    { name: "编码.txt", bytes: new Uint8Array([0xff, 0xfe, 0x41]), expected: "UTF-8" },
    { name: "二进制.txt", bytes: new TextEncoder().encode("要求\0不要口袋"), expected: "不允许" },
    { name: "网页.html", bytes: new TextEncoder().encode("  <!doctype html><html><body>需求</body></html>"), expected: "不允许" },
    { name: "脚本.txt", bytes: new TextEncoder().encode("<script>alert(1)</script>"), expected: "不允许" },
    { name: "图案.txt", bytes: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), expected: "不允许" },
    { name: "结构.xml", bytes: new TextEncoder().encode("<?xml version='1.0'?><需求/>"), expected: "不允许" },
    { name: "需求.json", bytes: new TextEncoder().encode('{"颜色":'), expected: "JSON" },
])("$name rejects unsupported source bytes before attaching a document", async ({ name, bytes, expected }) => {
    await expect(parseChatAttachment(new File([bytes], name))).rejects.toThrow(expected);
});

test("valid JSON remains exact JSON source rather than being rewritten as plain text", async () => {
    const original = new TextEncoder().encode('\uFEFF{"颜色":"红色","禁止":["口袋"]}');
    const document = (await parseChatAttachment(new File([original], "需求.json", { type: "application/json" }))).document!;
    expect(document.source!.mimeType).toBe("application/json");
    expect(sourceBytes(document.source!.dataUrl)).toEqual(original);
    expect(document.sections[0]!.text).toContain('"颜色":"红色"');
});

test("text documents keep exact original bytes and complete sections beyond the chat preview", async () => {
    const body = "袖长必须保留\r\n".repeat(18_000) + "末尾要求：不要口袋";
    const original = new TextEncoder().encode("\uFEFF" + body);
    const parsed = await parseChatAttachment(new File([original], "毛衫需求.txt", { type: "text/plain" }));
    expect(parsed.document?.kind).toBe("text");
    expect(parsed.document?.sections.map(section => section.text).join("")).toContain("末尾要求：不要口袋");
    expect(sourceBytes(parsed.document!.source!.dataUrl)).toEqual(original);
    expect(parsed.truncated).toBe(true);
});

test("workbook documents retain every late cell, row coordinate, sheet boundary and cached formula", async () => {
    const workbook = XLSX.utils.book_new();
    const rows = [["尺码", "胸围", "要求"], ...Array.from({ length: 650 }, (_, index) => ["M" + index, index + 80, "纹理必须完整，不要改变轮廓"]), ["最后尺码", 105, "末尾禁止口袋"]];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet.B2.f = "40+40";
    sheet["!merges"] = [{ s: { r: 0, c: 1 }, e: { r: 0, c: 2 } }];
    XLSX.utils.book_append_sheet(workbook, sheet, "尺寸");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["色号", "PANTONE 13-1007"]]), "颜色");
    const original = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
    const parsed = await parseChatAttachment(new File([original], "尺寸.xlsx"));
    const document = parsed.document!;
    expect(document.kind).toBe("workbook");
    expect(document.sections.length).toBeGreaterThan(2);
    expect(document.sections.find(section => section.text.includes("末尾禁止口袋"))?.text).toContain("胸围");
    const text = document.sections.map(section => section.text).join("\n");
    expect(text).toContain("末尾禁止口袋");
    expect(text).toContain("PANTONE 13-1007");
    expect(text).toContain("40+40");
    expect(text).toContain("B1:C1");
    expect(text).toContain("| 652 |");
    expect(sourceBytes(document.source!.dataUrl)).toEqual(original);
});

test("preview-byte overflow never leaves a dangling section figure reference", async () => {
    const { AgentDocumentBuilder } = await import("../src/lib/agent-document-parser");
    const builder = new AgentDocumentBuilder(new File(["brief"], "brief.txt"), "text", new TextEncoder().encode("brief"));
    const section = builder.section("款式", "保留此图的纹理");
    builder.figure(section, { name: "large.jpg", label: "文件图1", mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64," + "AAAA".repeat(Math.floor(AGENT_DOCUMENT_LIMITS.previewBytes / 3) + 1) });
    expect(builder.document.figures).toEqual([]);
    expect(section.figureIds).toEqual([]);
    expect(builder.document.warnings.join("\n")).toContain("24 MB");
});

test("a formatted distant Excel cell does not materialize a million empty rows", async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([["标题", "值"], ["胸围", 88]]);
    XLSX.utils.book_append_sheet(workbook, sheet, "正常数据");
    const archive = unzipSync(new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" })));
    archive["xl/worksheets/sheet1.xml"] = strToU8(strFromU8(archive["xl/worksheets/sheet1.xml"]!).replace(/<dimension ref="[^"]+"\/>/, '<dimension ref="A1:XFD1048576"/>'));
    const parsed = await parseChatAttachment(new File([zipSync(archive)], "宽格式.xlsx"));
    expect(parsed.document!.sections.map(section => section.text).join("\n")).toContain("胸围");
    expect(parsed.document!.sections.map(section => section.text).join("\n").length).toBeLessThan(500);
});

test("document budgets reject over-limit source bytes and complete text instead of silently losing requirements", async () => {
    await expect(parseChatAttachment(new File([new Uint8Array(AGENT_DOCUMENT_LIMITS.fileBytes + 1)], "大文件.txt"))).rejects.toThrow("20 MB");
    await expect(parseChatAttachment(new File(["a".repeat(AGENT_DOCUMENT_LIMITS.textCharacters + 1)], "长要求.txt"))).rejects.toThrow("1000000");
});

test("Word embedded figures stay associated with their section without reading linked external files", async () => {
    const { original, png } = wordDocumentFixture();
    const document = (await parseChatAttachment(new File([original], "款式.docx"))).document!;
    expect(document.figures).toHaveLength(1);
    const figure = document.figures[0]!;
    const section = document.sections.find(section => section.id === figure.sectionId)!;
    expect(section.figureIds).toContain(figure.id);
    expect(section.text).toContain("图示颜色必须保留");
    expect(section.text).not.toContain("不要口袋");
    expect(sourceBytes(figure.dataUrl)).toEqual(png);
    expect(document.warnings.join("\n")).toMatch(/外部|外链/);
    expect(sourceBytes(document.source!.dataUrl)).toEqual(original);
});
