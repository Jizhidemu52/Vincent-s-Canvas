import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createCache } from "../src/db";
import { openProductCandidatesReceiptConnection } from "../src/product-candidates-redis";
import { claimProductCandidatesReceipt, finishProductCandidatesReceipt, readProductCandidatesReceipt, productCandidatesRequestSchema } from "../src/product-candidates";

const redisUrl = process.env.QUEUE_TEST_REDIS_URL;
const redisTest = redisUrl ? test : test.skip;

redisTest("real Redis AOF confirms independent claims and finished receipts with owner isolation and no TTL", async () => {
    const parent = await createCache(redisUrl!);
    const owner = `candidate-test-${randomUUID()}`, requestId = `candidate-${randomUUID()}`;
    const key = `chat:product-candidates:v1:${createHash("sha256").update(JSON.stringify([owner, requestId])).digest("hex")}`;
    const request = productCandidatesRequestSchema.parse({ requestId, toolKey: "gpt-chat", profile: "product-candidates", profileContext: { sourceAssetId: randomUUID() }, input: [], tools: [] });
    try {
        const claims = await Promise.all(Array.from({ length: 25 }, async () => {
            const connection = await openProductCandidatesReceiptConnection(parent);
            try {
                const claim = await claimProductCandidatesReceipt(connection.cache, owner, request, "a".repeat(64), "test-model");
                if (claim.execute) expect(await connection.confirmPersistence()).toBe(true);
                return claim;
            } finally { connection.close(); }
        }));
        expect(claims.filter(item => item.execute)).toHaveLength(1);
        expect(Number(await parent.sendCommand(["TTL", key]))).toBe(-1);
        expect(await readProductCandidatesReceipt(parent, "other-owner", requestId)).toBeNull();
        await expect(claimProductCandidatesReceipt(parent, owner, request, "b".repeat(64), "test-model")).rejects.toMatchObject({ code: "PRODUCT_CANDIDATES_REQUEST_CHANGED" });
        const owned = claims.find(item => item.execute)!.stored;
        const connection = await openProductCandidatesReceiptConnection(parent);
        try {
            await finishProductCandidatesReceipt(connection.cache, owned, { status: "success", candidates: [] });
            expect(await connection.confirmPersistence()).toBe(true);
        } finally { connection.close(); }
        expect((await readProductCandidatesReceipt(parent, owner, requestId))!.receipt).toMatchObject({ status: "success", candidates: [] });
        await expect(finishProductCandidatesReceipt(parent, owned, { status: "failed" })).rejects.toMatchObject({ status: 503 });
        await parent.set(key, "corrupt-owned-test-data");
        await expect(readProductCandidatesReceipt(parent, owner, requestId)).rejects.toMatchObject({ status: 503 });
    } finally {
        // Only this test's cryptographically unique owner/request key. Never flush.
        await parent.del(key);
        await parent.quit();
    }
}, 20_000);
