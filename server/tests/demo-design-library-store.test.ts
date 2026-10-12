import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DemoDesignLibraryStore, type DemoLibraryAsset } from "../src/demo-design-library";
import { DemoStateStore } from "../src/demo-state-store";
import type { LibraryPrivateAsset, LibraryPublication, LibraryReceipt } from "../src/design-library";

const temporaryPrefix = "canvas-demo-library-store-";
async function temporaryStore() {
  const directory = resolve(await mkdtemp(join(tmpdir(), temporaryPrefix)));
  const withinTemporary = relative(resolve(tmpdir()), directory);
  if (isAbsolute(withinTemporary) || withinTemporary !== basename(directory) || !basename(directory).startsWith(temporaryPrefix)) throw new Error("Unverified temporary directory");
  return { path: join(directory, "state.sqlite"), cleanup: () => rm(directory, { recursive: true, force: true }) };
}
const date = "2026-10-09T00:00:00.000Z";
const privateAsset = (id: string, ownerId: string, entryId: string, imageId: string): LibraryPrivateAsset => ({
  id, ownerId, objectKey: `users/${ownerId}/${id}/original.png`, filename: "原图.png", mimeType: "image/png", byteSize: 4,
  kind: "image", status: "ready", deleted: false, departmentId: null, createdAt: date,
  metadata: { width: 1, height: 1, designLibrarySource: { entryId, imageId, title: "共享设计", authorName: "甲" } },
});
const publication = (authorId: string, index = 0): LibraryPublication => ({
  id: randomUUID(), title: `设计 ${index}`, thought: "完整设计思路", prompt: "完整提示词", tags: ["春季"],
  author: { id: authorId, name: "甲", departmentId: "department-a", departmentName: "设计部" },
  status: "published", createdAt: new Date(Date.parse(date) + index).toISOString(), updatedAt: date,
  requestId: `publication-${index}`, payloadHash: `hash-${index}`, images: [], moderationReason: null, moderatedBy: null,
});

test("SQLite library commits original snapshot and private reader bytes atomically; failures never update cache or survive restart", async () => {
  const fixture = await temporaryStore();
  const committed: DemoLibraryAsset[] = [];
  let library = new DemoDesignLibraryStore(fixture.path, asset => committed.push(asset));
  const state = new DemoStateStore<DemoLibraryAsset>(fixture.path);
  try {
    const sourceId = randomUUID();
    const source = { id: sourceId, ownerUserId: "author", filename: "source.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3, 4]), byteSize: 4, createdAt: date, metadata: {} };
    state.save({ assets: [source] });
    expect(await library.getSourceAsset(sourceId, "reader")).toBeNull();
    expect(await library.getSourceAsset(sourceId, "author")).toMatchObject({ ownerId: "author", status: "ready", byteSize: 4, deleted: false });
    const entry = publication("author");
    const imageId = randomUUID();
    const key = `design-library/${entry.id}/${imageId}`;
    const asset = privateAsset(randomUUID(), "reader", entry.id, imageId);
    await expect(library.transaction(async repo => {
      await library.write(key, source.bytes, "image/png");
      await repo.insertPublication(entry);
      await library.write(asset.objectKey, source.bytes, "image/png");
      await repo.insertPrivateAsset(asset);
      throw new Error("Simulated failure after bytes and rows were staged");
    })).rejects.toThrow("Simulated failure");
    expect(committed).toEqual([]);
    expect(state.load().assets.map(row => row.id)).toEqual([sourceId]);
    expect(await library.getPublication(entry.id)).toBeNull();
    await expect(library.read(key)).rejects.toThrow("不存在");
    const database = (library as unknown as { db: Database }).db;
    database.exec("PRAGMA query_only=ON");
    await expect(library.transaction(async repo => { await repo.insertPublication(entry); })).rejects.toThrow();
    database.exec("PRAGMA query_only=OFF");
    expect(committed).toEqual([]);
    expect(await library.getPublication(entry.id)).toBeNull();
    await library.transaction(async repo => {
      await library.write(key, source.bytes, "image/png");
      await repo.insertPublication(entry);
      await library.write(asset.objectKey, source.bytes, "image/png");
      await repo.insertPrivateAsset(asset);
      expect(committed).toEqual([]);
    });
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ id: asset.id, ownerUserId: "reader", metadata: asset.metadata, bytes: source.bytes });
    state.save({ assets: [{ ...source, bytes: new Uint8Array([4, 3, 2, 1]) }] });
    library.close();
    library = new DemoDesignLibraryStore(fixture.path);
    expect(await library.read(key)).toEqual(source.bytes);
    expect(state.load().assets.find(row => row.id === asset.id)?.bytes).toEqual(source.bytes);
    expect(await library.getSourceAsset(asset.id, "reader")).toMatchObject({ status: "ready", byteSize: 4 });
    expect(await library.getSourceAsset(asset.id, "author")).toBeNull();
    expect(await library.getPublication(entry.id)).toEqual(entry);
  } finally { library.close(); state.close(); await fixture.cleanup(); }
});

test("SQLite library paginates metadata and activity and counts entry UV across images without listing viewers", async () => {
  const fixture = await temporaryStore();
  const library = new DemoDesignLibraryStore(fixture.path);
  try {
    const entries = [publication("author", 0), publication("author", 1), publication("other", 2)];
    entries[2]!.status = "withdrawn";
    await library.transaction(async repo => { for (const entry of entries) await repo.insertPublication(entry); });
    const first = await library.listPublications({ query: "完整设计", tag: "春季", statuses: ["published"], page: 1, pageSize: 1 });
    expect(first.total).toBe(2);
    expect(first.items.map(entry => entry.id)).toEqual([entries[1]!.id]);
    expect(first.items[0]!.thought).toBe("");
    expect(first.items[0]!.prompt).toBe("");
    expect((await library.getPublication(entries[1]!.id))!.thought).toBe("完整设计思路");
    const second = await library.listPublications({ query: "", tag: "", authorId: "author", page: 2, pageSize: 1 });
    expect(second.total).toBe(2);
    expect(second.items.map(entry => entry.id)).toEqual([entries[0]!.id]);
    expect((await library.listPublications({ query: "", tag: "", departmentId: "unmanaged", page: 1, pageSize: 60 })).total).toBe(0);
    const entryId = entries[0]!.id;
    const [imageA, imageB] = [randomUUID(), randomUUID()];
    const makeReceipt = (actorId: string, action: LibraryReceipt["action"], imageId: string | null): LibraryReceipt => ({
      id: randomUUID(), key: randomUUID(), entryId, imageId, action, actorId, actorName: actorId, departmentName: "设计部", requestId: randomUUID(), createdAt: date,
    });
    const receipts = [makeReceipt("reader-a", "view", null), makeReceipt("reader-a", "view", null), makeReceipt("reader-a", "view", imageA),
      makeReceipt("reader-a", "download", imageA), makeReceipt("reader-a", "download", imageB), makeReceipt("reader-b", "download", imageA), makeReceipt("reader-a", "reuse", imageB)];
    await library.transaction(async repo => { for (const receipt of receipts) await repo.insertReceipt(receipt); });
    const metrics = await library.getMetricRows(entryId);
    expect(metrics.find(row => row.level === "entry" && row.action === "view")).toMatchObject({ count: 2, people: 1 });
    expect(metrics.find(row => row.level === "entry" && row.action === "download")).toMatchObject({ count: 3, people: 2 });
    expect(metrics.find(row => row.level === "image" && row.imageId === imageA && row.action === "download")).toMatchObject({ count: 2, people: 2 });
    const activity = await library.listActivity(entryId, 1, 2);
    expect(activity.total).toBe(4);
    expect(activity.items).toHaveLength(2);
    expect(activity.items.every(row => row.action === "download" || row.action === "reuse")).toBe(true);
    expect(await library.hasReceipt(receipts[0]!.key)).toBe(true);
    await expect(library.transaction(async repo => { await repo.insertReceipt(receipts[0]!); })).rejects.toThrow();
    expect(await library.getMetricRows(entryId)).toEqual(metrics);
  } finally { library.close(); await fixture.cleanup(); }
});

test("concurrent library requests cannot observe staged publication or media before a failed transaction rolls back", async () => {
  const fixture = await temporaryStore();
  const library = new DemoDesignLibraryStore(fixture.path);
  let unblock!: () => void;
  const barrier = new Promise<void>(resolve => { unblock = resolve; });
  let staged!: () => void;
  const ready = new Promise<void>(resolve => { staged = resolve; });
  const entry = publication("author");
  const writing = library.transaction(async repo => {
    await repo.insertPublication(entry);
    await library.write("design-library/uncommitted", new Uint8Array([1, 2]), "image/png");
    staged();
    await barrier;
    throw new Error("Simulated commit failure");
  });
  try {
    await ready;
    let returned = false;
    const reading = library.getPublication(entry.id).then(value => { returned = true; return value; });
    await Promise.resolve();
    await Promise.resolve();
    expect(returned).toBe(false);
    unblock();
    await expect(writing).rejects.toThrow("Simulated commit failure");
    expect(await reading).toBeNull();
    await expect(library.read("design-library/uncommitted")).rejects.toThrow("不存在");
  } finally { unblock(); await writing.catch(() => undefined); library.close(); await fixture.cleanup(); }
});
