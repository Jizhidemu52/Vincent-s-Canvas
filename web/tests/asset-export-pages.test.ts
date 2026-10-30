import { expect, test } from "bun:test";
import { collectAssetPages } from "../src/pages/assets/asset-export-pages";

test("export collects all filtered pages once, including entries not scrolled into view", async () => {
    const calls: (string | undefined)[] = [], counts: number[] = [];
    const result = await collectAssetPages(async cursor => {
        calls.push(cursor);
        return cursor ? { assets: [{ id: "a" }, { id: "b" }], hasMore: false, nextCursor: null }
            : { assets: [{ id: "a" }], hasMore: true, nextCursor: "next" };
    }, () => {}, count => counts.push(count));
    expect(result).toEqual([{ id: "a" }, { id: "b" }]);
    expect(calls).toEqual([undefined, "next"]); expect(counts).toEqual([1, 2]);
});

test("repeated/missing cursors never create a misleading partial export", async () => {
    for (const cursor of [null, "same"]) {
        await expect(collectAssetPages(async () => ({ assets: [{ id: "a" }], hasMore: true, nextCursor: cursor }), () => {})).rejects.toThrow("分页");
    }
});

test("account change while a page is loading aborts before collecting it", async () => {
    let sameOwner = true, progress = 0;
    await expect(collectAssetPages(async () => {
        sameOwner = false; return { assets: [{ id: "a" }], hasMore: false, nextCursor: null };
    }, () => { if (!sameOwner) throw new Error("account changed"); }, () => { progress++; })).rejects.toThrow("account changed");
    expect(progress).toBe(0);
});
