import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminPromptCompilation } from "../../shared/prompt-contracts";
import { CompilationResult } from "../src/pages/admin/prompt-recipes/components/compilation-history";

const compilation: AdminPromptCompilation = {
    id: "compilation", requestId: "request", status: "failed", optimized: false,
    errorCode: "PROMPT_OPTIMIZATION_FAILED", message: "动效规划失败，未提交生成",
    userId: "employee", recipeKey: "video-motion", recipeVersionId: "version",
    modelConfigId: "optimizer", targetModelConfigId: "video-model",
    inputSnapshot: { promptInput: { scene: "video-motion", mode: "video", fields: { duration: 10 }, userText: "", referenceRoles: [], hasMask: false }, sourceUrls: [] },
    inputHash: "hash", reusedFromId: null, cacheHit: false, rawResponse: null, latencyMs: 50,
    inputTokens: null, outputTokens: null, actualCost: null, estimatedCost: null, currency: "CNY",
    createdAt: "2026-11-04T00:00:00Z", completedAt: "2026-11-04T00:00:01Z",
};

test("admin result displays only the safe HTTP number and existing category beside the failure message", () => {
    const markup = renderToStaticMarkup(<CompilationResult compilation={{ ...compilation, upstreamStatus: 400, upstreamReason: "request_invalid" }} />);
    expect(markup).toContain("上游 HTTP 状态");
    expect(markup).toContain("400");
    expect(markup).toContain("上游安全分类");
    expect(markup).toContain("request_invalid");
    expect(markup).toContain(compilation.message!);
    expect(markup).not.toMatch(/access_denied|Operation not allowed|Bedrock/);
});

test("admin result does not invent diagnostics when the provider supplied none", () => {
    const markup = renderToStaticMarkup(<CompilationResult compilation={compilation} />);
    expect(markup).not.toContain("上游 HTTP 状态");
    expect(markup).not.toContain("上游安全分类");
    expect(markup).toContain(compilation.message!);
});
