import type { CellObject } from "xlsx";
import type { AgentDocumentBuilder } from "./agent-document-parser";
import { AGENT_DOCUMENT_LIMITS } from "../../../shared/image-agent-documents";

const markdownCell = (value: string) => value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");

/** SheetJS reads actual cells; an inflated formatting !ref never creates empty rows. */
export async function parseWorkbookDocument(bytes: Uint8Array, builder: AgentDocumentBuilder) {
    if (/\.xls$/i.test(builder.document.name) && ![0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((value, index) => bytes[index] === value)) {
        throw new Error("旧版 XLS 格式不受支持，请在 Excel 中另存为 XLSX 后上传；原文件未修改");
    }
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(bytes, { type: "array", cellFormula: true, cellText: true, cellStyles: true });
    if (workbook.SheetNames.length > AGENT_DOCUMENT_LIMITS.sections) throw new Error(`Excel 超过 ${AGENT_DOCUMENT_LIMITS.sections} 个工作表，请拆分后上传`);
    builder.warn("Excel 保留工作表、表头、单元格坐标、合并范围与公式缓存值；不计算公式，也不解析内嵌图片、图表、文本框或原始打印版式，这些内容仍保留在原文件中。参考图请另外上传。");
    let cellCount = 0;
    for (const [sheetIndex, name] of workbook.SheetNames.entries()) {
        const sheet = workbook.Sheets[name]!;
        const rows = new Map<number, Map<number, string>>(), columns = new Set<number>();
        for (const address of Object.keys(sheet)) {
            if (!/^[A-Z]+[1-9]\d*$/.test(address)) continue;
            const item = sheet[address] as CellObject;
            if (item.v === undefined && !item.f) continue;
            if (++cellCount > 200_000) throw new Error("Excel 超过 200000 个有内容单元格，请拆分后上传；未截断保存");
            const position = XLSX.utils.decode_cell(address);
            const display = item.w ?? (item.v === undefined ? "" : XLSX.utils.format_cell(item));
            const text = `${display}${item.f ? `${display ? " " : ""}（公式：=${item.f}${item.v === undefined ? "；无缓存值，未计算" : ""}）` : ""}`;
            if (!text.trim()) continue;
            if (!rows.has(position.r)) rows.set(position.r, new Map());
            rows.get(position.r)!.set(position.c, text);
            columns.add(position.c);
        }
        const sortedRows = [...rows.keys()].sort((a, b) => a - b), sortedColumns = [...columns].sort((a, b) => a - b);
        const metadata = [`[工作表：${name}]`, ...(workbook.Workbook?.Sheets?.[sheetIndex]?.Hidden ? ["（隐藏工作表，内容仍已读取）"] : []), ...(sheet["!merges"]?.length ? [`合并单元格：${sheet["!merges"].map(range => XLSX.utils.encode_range(range)).join("、")}`] : [])].join("\n");
        if (!sortedRows.length) { builder.section(`工作表：${name}`, `${metadata}\n（空表）`); continue; }
        const sparse = sortedColumns.length > 80;
        if (sparse) builder.warn(`工作表“${name}”超过 80 个有值列，改用带精确单元格地址的表格，未省略单元格内容。`);
        const firstRow = rows.get(sortedRows[0]!)!;
        const columnLabel = (column: number) => {
            const value = firstRow.get(column) || "";
            const label = value.length > 96 ? `${value.slice(0, 96)}…（首行节选）` : value;
            return `${XLSX.utils.encode_col(column)}${label ? `（首行 ${sortedRows[0]! + 1}：${markdownCell(label)}）` : ""}`;
        };
        const header = sparse ? "| 单元格 | 内容 |\n| --- | --- |" : `| 行 | ${sortedColumns.map(columnLabel).join(" | ")} |\n| --- | ${sortedColumns.map(() => "---").join(" | ")} |`;
        let lines: string[] = [], startRow = sortedRows[0]!, endRow = startRow, characters = 0;
        const flush = () => {
            if (!lines.length) return;
            builder.section(`工作表：${name} · 行 ${startRow + 1}–${endRow + 1}`, `${metadata}\n${header}\n${lines.join("\n")}`);
            lines = []; characters = 0;
        };
        for (const row of sortedRows) {
            const values = rows.get(row)!;
            const line = sparse ? [...values].sort(([a], [b]) => a - b).map(([column, value]) => `| ${XLSX.utils.encode_cell({ r: row, c: column })} | ${markdownCell(value)} |`).join("\n")
                : `| ${row + 1}${sheet["!rows"]?.[row]?.hidden ? "（隐藏）" : ""} | ${sortedColumns.map(column => markdownCell(values.get(column) || "")).join(" | ")} |`;
            if (lines.length && (lines.length >= 200 || characters + line.length > 20_000)) flush();
            if (!lines.length) startRow = row;
            endRow = row; lines.push(line); characters += line.length;
        }
        flush();
    }
}
