import { exportUsageRecords, type UsageExportResult, type UsageFilters } from "../services/api/usage-analytics";
import { omitFinancialFields, usageDisplayExplanation } from "./financial-presentation";

function displayLine(value: unknown): unknown {
    const projected = omitFinancialFields(value);
    if (projected && typeof projected === "object" && "type" in projected && projected.type === "manifest" && "coverage" in projected) {
        const coverage = projected.coverage;
        if (coverage && typeof coverage === "object" && "notes" in coverage && Array.isArray(coverage.notes)) {
            coverage.notes = coverage.notes.map(note => typeof note === "string" ? usageDisplayExplanation(note) : note).filter(note => note !== "");
        }
    }
    return projected;
}

/** Display-only download. The validated original API export and server accounting remain unchanged. */
export async function exportNonFinancialUsageRecords(filters: UsageFilters, options: Parameters<typeof exportUsageRecords>[1] = {}): Promise<UsageExportResult> {
    const decoder = new TextDecoder(), encoder = new TextEncoder();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let pending = "";
    const writeLine = async (line: string) => {
        if (!line.trim()) return;
        options.signal?.throwIfAborted();
        const projected = encoder.encode(`${JSON.stringify(displayLine(JSON.parse(line)))}\n`);
        if (options.writeChunk) await options.writeChunk(projected);
        else chunks.push(projected);
    };
    // Always consume through a sink: writable output retains only its unfinished line,
    // while browser download buffers only the projected bytes required for its Blob.
    const result = await exportUsageRecords(filters, { ...options, writeChunk: async chunk => {
        pending += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            await writeLine(line);
        }
    } });
    pending += decoder.decode();
    await writeLine(pending);
    options.signal?.throwIfAborted();
    return { ...result, manifest: displayLine(result.manifest) as UsageExportResult["manifest"], blob: options.writeChunk ? null : new Blob(chunks, { type: "application/x-ndjson;charset=utf-8" }) };
}
