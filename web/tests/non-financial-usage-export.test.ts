import { afterEach, expect, test } from "bun:test";
import { exportNonFinancialUsageRecords } from "../src/lib/non-financial-usage-export";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const encoder = new TextEncoder();
const filters = { userIds: ["user-1"], from: "2026-11-11T16:00:00.000Z", to: "2026-11-12T16:00:00.000Z" };
const manifest = { type: "manifest", version: 1, filters, coverage: { collectionStartedAt: null, historicalTasksAvailable: true, historicalClicksAvailable: false, historicalChatAvailable: false, notes: ["原始业务备注保留"] }, exportedAt: "2026-11-12T08:00:00.000Z" };
const record = { type: "record", record: { id: "record-1", kind: "generation", totalRmbCost: 123.456789, generatedImages: 0, prompt: '中文、😀、"报价99元"\n第二行 rmbCostOverride 不删', parameters: { width: 0, credits: 7, nesting: { creditCostOverride: 3, rmbCostOverride: 0, keep: null }, items: [{ costUsd: 0.5, label: "价格文字" }] } } };
const projectedRecord = { type: "record", record: { id: "record-1", kind: "generation", generatedImages: 0, prompt: record.record.prompt, parameters: { width: 0, nesting: { keep: null }, items: [{ label: "价格文字" }] } } };
const completed = { type: "complete", recordCount: 1 };
const lines = (rows: unknown[], trailing = "\n") => rows.map(row => JSON.stringify(row)).join("\n") + trailing;
function response(text: string, chunkSize = 1) {
    const data = encoder.encode(text);
    return new Response(new ReadableStream({ start(controller) {
        for (let offset = 0; offset < data.length; offset += chunkSize) controller.enqueue(data.slice(offset, offset + chunkSize));
        controller.close();
    } }), { headers: { "content-type": "application/x-ndjson" } });
}

test("download projection removes monetary values across split UTF-8 chunks without altering other fields or request scope", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { calls.push(init!); return response(lines([manifest, record, completed])); }) as typeof fetch;
    const progress: number[] = [];
    const result = await exportNonFinancialUsageRecords(filters, { onProgress: count => progress.push(count) });
    expect((await result.blob!.text()).trim().split("\n").map(line => JSON.parse(line))).toEqual([manifest, projectedRecord, completed]);
    expect(result.recordCount).toBe(1);
    expect(result.manifest).toEqual(manifest);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", credentials: "include", cache: "no-store" });
    expect(JSON.parse(String(calls[0].body))).toEqual(filters);
    expect(progress.at(-1)).toBe(1);
});

test("writable output streams before source completion and does not retain a second whole-file Blob", async () => {
    let source: ReadableStreamDefaultController<Uint8Array>;
    let firstWrite!: () => void;
    const wrote = new Promise<void>(resolve => { firstWrite = resolve; });
    const written: string[] = [];
    globalThis.fetch = (async () => new Response(new ReadableStream({ start(controller) {
        source = controller;
        controller.enqueue(encoder.encode(lines([manifest, record])));
    } }), { headers: { "content-type": "application/x-ndjson" } })) as typeof fetch;
    const work = exportNonFinancialUsageRecords(filters, { writeChunk: async chunk => { written.push(new TextDecoder().decode(chunk)); firstWrite(); } });
    await wrote;
    expect(written.join("")).not.toContain('"totalRmbCost"');
    source!.enqueue(encoder.encode(JSON.stringify(completed))); // Last line without newline remains valid.
    source!.close();
    const result = await work;
    expect(result.blob).toBeNull();
    expect(result.recordCount).toBe(1);
    expect(written.join("").trim().split("\n").map(line => JSON.parse(line))).toEqual([manifest, projectedRecord, completed]);
});

for (const [name, rows] of Object.entries({ incomplete: [manifest, record], mismatch: [manifest, record, { type: "complete", recordCount: 3 }], afterComplete: [manifest, completed, record], noManifest: [record, completed] })) {
    test(`projected export still refuses ${name} stream without a successful result or retry`, async () => {
        let requests = 0;
        globalThis.fetch = (async () => { requests++; return response(lines(rows), 31); }) as typeof fetch;
        await expect(exportNonFinancialUsageRecords(filters)).rejects.toThrow();
        expect(requests).toBe(1);
    });
}

test("cancellation during writable output preserves AbortError and stops later writes", async () => {
    const controller = new AbortController();
    let writes = 0, requests = 0;
    globalThis.fetch = (async () => { requests++; return response(lines([manifest, record, completed]), 65536); }) as typeof fetch;
    await expect(exportNonFinancialUsageRecords(filters, { signal: controller.signal, writeChunk: async () => { writes++; controller.abort(); } })).rejects.toHaveProperty("name", "AbortError");
    expect(writes).toBe(1);
    expect(requests).toBe(1);
});

test("writable rejection never returns completion and never retries the export", async () => {
    let requests = 0;
    globalThis.fetch = (async () => { requests++; return response(lines([manifest, record, completed]), 65536); }) as typeof fetch;
    await expect(exportNonFinancialUsageRecords(filters, { writeChunk: async () => { throw new Error("Disk unavailable"); } })).rejects.toThrow();
    expect(requests).toBe(1);
});

test("only known manifest coverage finance explanations are projected; matching prompt text stays unchanged", async () => {
    const financeNote = "生成成本汇总已保存的成功生成历史人民币金额（含图片、视频和音频），不按新单价重算；不含未独立结算的聊天费用及失败、待处理任务的预估金额。";
    const sourceManifest = { ...manifest, coverage: { ...manifest.coverage, notes: [financeNote, "当前筛选中有 2 个成功任务缺少成功结算历史，费用未计入且不补估；已保存的图片结果仍计入张数。", "未上报缺口可能未知。", "用户业务记录提到价格，不是系统费用说明。"] } };
    const sourceRecord = { ...record, record: { ...record.record, prompt: financeNote } };
    globalThis.fetch = (async () => response(lines([sourceManifest, sourceRecord, completed]), 17)) as typeof fetch;
    const result = await exportNonFinancialUsageRecords(filters);
    const output = (await result.blob!.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(output[0].coverage.notes).toEqual(["已保存的图片结果仍计入张数。", "未上报缺口可能未知。", "用户业务记录提到价格，不是系统费用说明。"]);
    expect(result.manifest.coverage.notes).toEqual(output[0].coverage.notes);
    expect(output[1].record.prompt).toBe(financeNote);
    expect(sourceManifest.coverage.notes).toHaveLength(4);
});
