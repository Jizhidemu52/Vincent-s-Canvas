import { expect, test } from "bun:test";
import type { Asset } from "../src/stores/use-asset-store";
import { buildAssetSearchIndex, searchAssetIndex } from "../src/pages/assets/asset-search";

function asset(id: string, title: string, content: string): Asset {
    return { id, title, ownerId: "owner", kind: "text", coverUrl: "", tags: ["产品"], source: "设计", note: "内审", metadata: { prompt: "细节特写", model: "GPT", module: "LLM" }, createdAt: "", updatedAt: "", data: { content } };
}

test("asset searches retain case-insensitive title, full text, tags and trace metadata coverage", () => {
    const input = asset("1", "衬衫 Shirt", "完整面料说明 Cotton");
    const index = buildAssetSearchIndex([input]);
    for (const query of ["shirt", "COTTON", "产品", "设计", "内审", "细节特写", "gpt", "llm"]) {
        expect(searchAssetIndex(index, query, "all")).toEqual([input]);
    }
    expect(searchAssetIndex(index, "  SHIRT  ", "text")).toEqual([input]);
    expect(searchAssetIndex(index, "shirt", "image")).toEqual([]);
    expect(searchAssetIndex(index, "missing", "all")).toEqual([]);
});

test("repeated searches do not reread or rebuild 1000 full-text assets", () => {
    let reads = 0;
    const input = Array.from({ length: 1000 }, (_, index) => {
        const item = asset(String(index), `设计${index}`, "");
        if (item.kind === "text") Object.defineProperty(item.data, "content", { get: () => { reads += 1; return "服装说明".repeat(1000); } });
        return item;
    });
    const index = buildAssetSearchIndex(input);
    expect(reads).toBe(1000);
    for (const keyword of ["服", "服装", "服装说", "服装说明", "设计1", "设计10"]) searchAssetIndex(index, keyword, "all");
    expect(reads).toBe(1000);
    expect(searchAssetIndex(index, "", "all")).toEqual(input);
});

test("rebuilding after an edit replaces stale search text", () => {
    const input = asset("1", "旧标题", "旧正文");
    const changed = { ...input, title: "新标题" };
    const index = buildAssetSearchIndex([changed]);
    expect(searchAssetIndex(index, "旧标题", "all")).toEqual([]);
    expect(searchAssetIndex(index, "新标题", "all")).toEqual([changed]);
});
