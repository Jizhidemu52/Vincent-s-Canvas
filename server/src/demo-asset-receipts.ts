import { z } from "zod";

export const demoDownloadReceiptSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(160), filename: z.string().trim().max(255).optional(),
}).strict();

export type DemoDownloadReceipt = { id: string; idempotencyKey: string; occurredAt: string; filename: string | null };
export type DemoDownloadReceiptAsset = { id: string; downloadReceipts?: DemoDownloadReceipt[] };

/** Private server-owned fields: upload metadata and ordinary image reads cannot increment downloads. */
export function demoDownloadProjection(asset: DemoDownloadReceiptAsset) {
  const receipts = asset.downloadReceipts || [];
  return { resultStatus: receipts.length ? "downloaded" : "unused", usabilityScore: receipts.length ? 15 : 0,
    downloadCount: receipts.length, firstDownloadedAt: receipts[0]?.occurredAt || null, eventCount: receipts.length };
}

export function appendDemoDownloadReceipt<T extends DemoDownloadReceiptAsset>(asset: T, input: z.output<typeof demoDownloadReceiptSchema>) {
  const existing = asset.downloadReceipts?.find(item => item.idempotencyKey === input.idempotencyKey);
  if (existing) return { asset, eventId: existing.id, duplicate: true, projection: demoDownloadProjection(asset) };
  const receipt: DemoDownloadReceipt = { id: crypto.randomUUID(), idempotencyKey: input.idempotencyKey, occurredAt: new Date().toISOString(), filename: input.filename || null };
  const next = { ...asset, downloadReceipts: [...(asset.downloadReceipts || []), receipt] };
  return { asset: next, eventId: receipt.id, duplicate: false, projection: demoDownloadProjection(next) };
}
