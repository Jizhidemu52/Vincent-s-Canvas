import { expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { parseChatAttachment } from "../src/lib/chat-attachments";

const workbook = () => {
    const value = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(value, XLSX.utils.aoa_to_sheet([["Style", "Color"], ["A01", "Red"]]), "Design");
    return value;
};

test.each(["biff5", "biff8"] as const)("%s XLS originals retain workbook content and exact bytes before cloud save", async bookType => {
    const original = new Uint8Array(XLSX.write(workbook(), { type: "array", bookType }));
    const parsed = await parseChatAttachment(new File([original], "design.xls", { type: "application/octet-stream" }));
    expect(parsed.document?.sections.map(section => section.text).join("\n")).toContain("A01");
    expect(parsed.document?.source?.mimeType).toBe("application/vnd.ms-excel");
    expect(new Uint8Array(Buffer.from(parsed.document!.source!.dataUrl.split(",")[1]!, "base64"))).toEqual(original);
});

test("raw legacy BIFF and HTML masquerading as XLS are rejected before joining the saved document", async () => {
    const raw = new Uint8Array(XLSX.write(workbook(), { type: "array", bookType: "biff2" }));
    for (const bytes of [raw, new TextEncoder().encode("<table><tr><td>Style</td></tr></table>")]) {
        await expect(parseChatAttachment(new File([bytes], "design.xls", { type: "application/vnd.ms-excel" }))).rejects.toThrow("另存为 XLSX");
    }
});
