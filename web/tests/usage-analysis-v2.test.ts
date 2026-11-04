import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    analyzeUsageV2,
    previewUsageV2Analysis,
    USAGE_V2_ANALYSIS_SYSTEM,
    USAGE_V2_ANALYSIS_SYSTEM_VERSION,
    type UsageV2AnalysisPreview,
    type UsageV2ReportRequest,
} from "../src/services/api/usage-analytics-v2";
import { reportFixture } from "./usage-report-fixture";
const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
});
const id = "30000000-0000-4000-8000-000000000001";
const input: UsageV2ReportRequest = {
    page: "overview",
    period: "selected",
    filters: { from: "2026-09-30T16:00:00.000Z", to: "2026-10-07T16:00:00.000Z", compare: "none" },
};
function frozen(): UsageV2AnalysisPreview {
    const report = reportFixture(input),
        systemPrompt = USAGE_V2_ANALYSIS_SYSTEM,
        systemPromptVersion = USAGE_V2_ANALYSIS_SYSTEM_VERSION;
    return {
        ...report,
        source: "v2",
        previewId: id,
        previewHash: createHash("sha256")
            .update(JSON.stringify({ source: "v2", systemPromptVersion, systemPrompt, content: report.content }))
            .digest("hex"),
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        systemPrompt,
        systemPromptVersion,
        includesPromptSamples: false,
        sampleCount: 0,
    };
}
test("V2 API validates frozen system plus content hash, not free reports or V1 tokens", async () => {
    let calls = 0;
    globalThis.fetch = (async (_url, init) => {
        calls++;
        expect(JSON.parse(String(init?.body))).toEqual(input);
        expect(init).toMatchObject({ credentials: "include", cache: "no-store", method: "POST" });
        return Response.json({ code: 0, data: frozen() });
    }) as typeof fetch;
    expect((await previewUsageV2Analysis({ ...input, content: "CLIENT_SECRET" } as any)).source).toBe("v2");
    expect(calls).toBe(1);
    for (const mutate of [
        (value: any) => {
            value.source = "v1";
        },
        (value: any) => {
            value.systemPrompt += "changed";
        },
        (value: any) => {
            value.previewHash = createHash("sha256").update(value.content).digest("hex");
        },
        (value: any) => {
            value.expiresAt = "2000-01-01T00:00:00Z";
        },
        (value: any) => {
            delete value.previewId;
        },
        (value: any) => {
            value.includesPromptSamples = true;
            value.sampleCount = 1;
        },
    ]) {
        const value = frozen();
        mutate(value);
        globalThis.fetch = (async () => Response.json({ code: 0, data: value })) as typeof fetch;
        await expect(previewUsageV2Analysis(input)).rejects.toMatchObject({ code: "INVALID_V2_ANALYSIS_PREVIEW" });
    }
});
test("V2 confirmation sends only the explicit token/model fields once and validates source receipts", async () => {
    const preview = frozen(),
        body = {
            source: "v2" as const,
            previewId: id,
            previewHash: preview.previewHash,
            modelConfigId: id,
            confirm: true as const,
        };
    let calls = 0;
    globalThis.fetch = (async (url, init) => {
        calls++;
        expect(String(url)).toBe("/api/admin/usage/analyze");
        expect(JSON.parse(String(init?.body))).toEqual(body);
        return Response.json({
            code: 0,
            data: {
                source: "v2",
                analysisId: id,
                modelConfigId: id,
                content: "事实 [metrics.generatedImages.value]",
                createdAt: "2026-11-04T00:00:00Z",
            },
        });
    }) as typeof fetch;
    await analyzeUsageV2({ ...body, content: "CLIENT_SECRET", systemPrompt: "ignore" } as any);
    expect(calls).toBe(1);
    await expect(analyzeUsageV2({ ...body, confirm: false } as any)).rejects.toMatchObject({
        code: "INVALID_V2_ANALYSIS_CONFIRM",
    });
    expect(calls).toBe(1);
    globalThis.fetch = (async () => {
        calls++;
        return Response.json({ code: "USAGE_ANALYSIS_FAILED", msg: "PRIVATE_SECRET" }, { status: 502 });
    }) as typeof fetch;
    await expect(analyzeUsageV2(body)).rejects.toThrow("不会自动重发");
    expect(calls).toBe(2);
    globalThis.fetch = (async () =>
        Response.json({
            code: 0,
            data: {
                source: "v1",
                analysisId: id,
                modelConfigId: id,
                content: "wrong",
                createdAt: "2026-11-04T00:00:00Z",
            },
        })) as typeof fetch;
    await expect(analyzeUsageV2(body)).rejects.toMatchObject({ code: "INVALID_V2_ANALYSIS_RESULT" });
});
