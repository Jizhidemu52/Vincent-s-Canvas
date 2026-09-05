import { expect, test } from "bun:test";
import * as XLSX from "xlsx";

import { MAX_CHAT_ATTACHMENT_TEXT_LENGTH, MAX_WORKBOOK_MODEL_TEXT_LENGTH, chatAttachmentParserKind, formatPdfText, formatWorkbookText, isSupportedChatAttachment, parseChatAttachment, truncateChatAttachmentText, truncateWorkbookText } from "../src/lib/chat-attachments";

test("loads heavyweight office parsers only for the matching attachment type", () => {
    expect(chatAttachmentParserKind({ name: "notes.txt", type: "text/plain" })).toBeNull();
    expect(chatAttachmentParserKind({ name: "lookbook.PDF", type: "application/pdf" })).toBe("pdf");
    expect(chatAttachmentParserKind({ name: "inventory.xlsx", type: "" })).toBe("workbook");
    expect(chatAttachmentParserKind({ name: "brief.docx", type: "" })).toBe("docx");
});

test("accepts office documents, PDFs, text and source-code attachments", () => {
    expect(isSupportedChatAttachment({ name: "销售表.xlsx", type: "" })).toBe(true);
    expect(isSupportedChatAttachment({ name: "销售表.xls", type: "application/vnd.ms-excel" })).toBe(true);
    expect(isSupportedChatAttachment({ name: "材料.pdf", type: "application/pdf" })).toBe(true);
    expect(isSupportedChatAttachment({ name: "方案.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).toBe(true);
    expect(isSupportedChatAttachment({ name: "download.py", type: "text/x-python" })).toBe(true);
    expect(isSupportedChatAttachment({ name: "archive.zip", type: "application/zip" })).toBe(false);
});

test("marks attachment text when it exceeds the model-safe limit", () => {
    const result = truncateChatAttachmentText("a".repeat(80_001));
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[附件内容已截断]");
    expect(result.text.length).toBeLessThanOrEqual(80_000);
});

test("preserves PDF page and Excel worksheet boundaries in extracted text", () => {
    expect(formatPdfText(["第一页", "第二页"])).toContain("[第 2 页]\n第二页");
    expect(formatWorkbookText([{ name: "销售", rows: [["日期", "金额"], ["2026-08-13", 100]] }])).toContain("[工作表：销售]\n日期\t金额\n2026-08-13\t100");
});

test("does not turn a formatted wide Excel row into thousands of empty TSV cells", () => {
    const formattedTail = Array.from({ length: 16_382 }, () => "");

    expect(formatWorkbookText([{ name: "时间轴", rows: [["阶段", "日期", ...formattedTail]] }]))
        .toBe("[工作表：时间轴]\n阶段\t日期");
});

test("keeps every worksheet visible when a large workbook is shortened for the model", () => {
    const text = truncateWorkbookText([
        { name: "Orders", rows: [["order", "A".repeat(50_000)]] },
        { name: "Timeline", rows: [["milestone", "B".repeat(50_000)]] },
        { name: "Requirements", rows: [["requirement", "C".repeat(50_000)]] },
    ]);

    expect(text.length).toBeLessThanOrEqual(MAX_CHAT_ATTACHMENT_TEXT_LENGTH);
    expect(text.length).toBeLessThanOrEqual(MAX_WORKBOOK_MODEL_TEXT_LENGTH);
    expect(MAX_WORKBOOK_MODEL_TEXT_LENGTH).toBe(8_000);
    expect(text).toContain("[工作表：Orders]");
    expect(text).toContain("[工作表：Timeline]");
    expect(text).toContain("[工作表：Requirements]");
    expect(text).toContain("[Excel 工作簿内容已按工作表截断]");
});

test("extracts an actual XLSX attachment into model-readable TSV", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["sku", "quantity"], ["A-01", 12]]), "Inventory");
    const file = new File([XLSX.write(workbook, { type: "array", bookType: "xlsx" })], "inventory.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const attachment = await parseChatAttachment(file);

    expect(attachment.kind).toBe("text");
    expect(attachment.textContent).toContain("[工作表：Inventory]");
    expect(attachment.textContent).toContain("sku\tquantity\nA-01\t12");
});

test("marks a workbook as shortened when it is sampled across worksheets", async () => {
    const workbook = XLSX.utils.book_new();
    for (const name of ["Orders", "Timeline", "Requirements"]) {
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
            ["field", "value"],
            ["detail", name.repeat(2_000)],
            ["detail", name.repeat(2_000)],
        ]), name);
    }
    const file = new File([XLSX.write(workbook, { type: "array", bookType: "xlsx" })], "large.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const attachment = await parseChatAttachment(file);

    expect(attachment.truncated).toBe(true);
    expect(attachment.textContent).toContain("[工作表：Requirements]");
});
