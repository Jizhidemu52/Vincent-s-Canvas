import { expect, test } from "bun:test";
import { appendDemoDownloadReceipt, demoDownloadProjection, demoDownloadReceiptSchema } from "../src/demo-asset-receipts";
import { DemoStateStore } from "../src/demo-state-store";

test("download receipt is idempotent, retains source bytes, and survives durable serialization", () => {
  const store = new DemoStateStore(":memory:");
  try {
    const source = { id: crypto.randomUUID(), bytes: new Uint8Array([2, 3, 5]), ownerUserId: "owner", metadata: { downloadCount: 900 } };
    expect(demoDownloadProjection(source).downloadCount).toBe(0);
    const first = appendDemoDownloadReceipt(source, demoDownloadReceiptSchema.parse({ idempotencyKey: "receipt-1", filename: "source.png" }));
    const repeat = appendDemoDownloadReceipt(first.asset, { idempotencyKey: "receipt-1" });
    expect(repeat.eventId).toBe(first.eventId);
    expect(repeat.duplicate).toBe(true);
    expect(repeat.projection.downloadCount).toBe(1);
    expect(repeat.asset.bytes).toBe(source.bytes);
    store.save({ assets: [repeat.asset] });
    const restored = store.load().assets[0]! as typeof first.asset;
    expect(restored.bytes).toEqual(source.bytes);
    expect(demoDownloadProjection(restored)).toEqual(first.projection);
    const second = appendDemoDownloadReceipt(restored, { idempotencyKey: "receipt-2" });
    expect(second.projection.downloadCount).toBe(2);
    expect(second.projection.usabilityScore).toBe(15);
    expect(second.projection.firstDownloadedAt).toBe(first.projection.firstDownloadedAt);
  } finally { store.close(); }
});

test("receipt fields cannot inject owner, counts, or invalid identifiers", () => {
  for (const input of [{ idempotencyKey: "short" }, { idempotencyKey: "receipt-1", ownerUserId: "other" }, { idempotencyKey: "receipt-1", downloadCount: 500 }]) {
    expect(demoDownloadReceiptSchema.safeParse(input).success).toBe(false);
  }
});
