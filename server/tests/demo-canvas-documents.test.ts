import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CanvasDocumentError } from "../src/canvas-document";
import { DemoCanvasDocumentStore } from "../src/demo-canvas-documents";
import { compactHistoryAssetId, expectedCanvasSummary, largeCanvasDocument } from "./canvas-document-fixtures";

const paths: string[] = [];
const connections: DemoCanvasDocumentStore[] = [];
const assetId = "e345e1f8-0e4b-44a8-9d07-fba6d792f3aa";

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "canvas-documents-"));
  paths.push(directory);
  return join(directory, "nested", "demo.sqlite");
}
function open(path = databasePath()) {
  const store = new DemoCanvasDocumentStore(path);
  connections.push(store);
  return store;
}
function document(id = "canvas-a", media = `/api/assets/${assetId}/content`) {
  return {
    id, title: "完整画布 · 原样保存", createdAt: "2026-09-17T10:00:00.000Z", updatedAt: "2026-09-17T11:00:00.000Z",
    nodes: [
      { id: "image-1", type: "image", title: "原图", width: 1251, height: 867, position: { x: 12.25, y: -31.5 }, metadata: { content: media, originalWidth: 1251, originalHeight: 867, unknownFutureField: ["保留", 17] } },
      { id: "text-1", type: "text", title: "提示词", width: 320, height: 120, position: { x: 1500, y: 0 }, metadata: { content: "保留中英文提示词及多行\nKeep original text" } },
    ],
    connections: [{ id: "link-1", fromNodeId: "image-1", toNodeId: "text-1" }],
    chatSessions: [{ id: "chat-1", title: "设计讨论", createdAt: "2026-09-17T10:00:00.000Z", updatedAt: "2026-09-17T10:01:00.000Z", messages: [{ id: "message-1", role: "user", text: "保留原图", attachments: [{ type: "image", url: media }] }] }],
    activeChatId: "chat-1", backgroundMode: "dots", showImageInfo: true, viewport: { x: -180.5, y: 71.25, k: 0.625 },
  };
}

afterEach(() => {
  for (const store of connections.splice(0)) store.close();
  for (const directory of paths.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("whole documents retain nested graph, chat, dimensions and viewport across SQLite restart", () => {
  const path = databasePath();
  const first = open(path);
  const source = { ...document(), groups: [{ id: "style-a", title: "款式 A", nodeIds: ["image-1", "text-1"], collapsed: true }],
    history: { past: [{ ...document(), groups: [] }], future: [] } };
  const saved = first.put("employee-a", source.id, { baseRevision: 0, document: source }, id => id === assetId);
  expect(saved).toMatchObject({ ok: true, document: { id: source.id, revision: 1, deleted: false, document: source } });
  const database = Reflect.get(first, "db") as Database;
  expect(database.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  expect(database.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
  connections.splice(connections.indexOf(first), 1); first.close();
  const reopened = open(path);
  expect(reopened.get("employee-a", source.id)).toEqual(saved.document);
  expect(reopened.summaries("employee-a")).toEqual([{ id: source.id, revision: 1, deleted: false, updatedAt: saved.document.updatedAt,
    summary: { id: source.id, title: source.title, createdAt: source.createdAt, updatedAt: source.updatedAt, nodeCount: 2, connectionCount: 1, cover: { content: source.nodes[0]!.metadata.content } } }]);
  const detached = reopened.get("employee-a", source.id);
  detached.document!.title = "changed only in caller";
  expect(reopened.get("employee-a", source.id).document).toEqual(source);
});

test("the same document ID is independently owned by each employee", () => {
  const store = open();
  store.put("employee-a", "canvas-a", { baseRevision: 0, document: document() }, () => true);
  store.put("employee-b", "canvas-a", { baseRevision: 0, document: { ...document(), title: "乙的画布" } }, () => true);
  expect(store.summaries("employee-a").map(item => item.summary?.title)).toEqual(["完整画布 · 原样保存"]);
  expect(store.summaries("employee-b").map(item => item.summary?.title)).toEqual(["乙的画布"]);
  expect(store.get("employee-a", "canvas-a").document).toEqual(document());
  expect(store.get("employee-b", "canvas-a").document).toEqual({ ...document(), title: "乙的画布" });
  expect(store.summaries("unknown")).toEqual([]);
  expect(store.get("unknown", "canvas-a")).toEqual({ id: "canvas-a", revision: 0, deleted: true, document: null, updatedAt: "1970-01-01T00:00:00.000Z" });
});

test("separate database connections use atomic CAS and return the exact winning version", () => {
  const path = databasePath(), a = open(path), b = open(path);
  a.put("employee-a", "canvas-a", { baseRevision: 0, document: document() }, () => true);
  const winner = b.put("employee-a", "canvas-a", { baseRevision: 1, document: { ...document(), title: "设备 B 已保存" } }, () => true);
  const rejected = a.put("employee-a", "canvas-a", { baseRevision: 1, document: { ...document(), title: "设备 A 旧版本" } }, () => true);
  expect(winner.document.revision).toBe(2);
  expect(rejected).toEqual({ ok: false, document: winner.document });
  expect(a.get("employee-a", "canvas-a")).toEqual(winner.document);
  expect(a.summaries("employee-a")).toMatchObject([{ revision: 2, summary: { title: "设备 B 已保存" } }]);
});

test("deletion creates a durable tombstone that stale or refreshed devices cannot revive", () => {
  const path = databasePath(), store = open(path);
  store.put("employee-a", "canvas-a", { baseRevision: 0, document: document() }, () => true);
  const deleted = store.put("employee-a", "canvas-a", { baseRevision: 1, document: null }, () => false);
  expect(deleted).toMatchObject({ ok: true, document: { id: "canvas-a", revision: 2, deleted: true, document: null } });
  const reopened = open(path);
  for (const baseRevision of [0, 1, 2]) expect(reopened.put("employee-a", "canvas-a", { baseRevision, document: document() }, () => true)).toEqual({ ok: false, document: deleted.document });
  expect(reopened.get("employee-a", "canvas-a")).toEqual(deleted.document);
  expect(reopened.summaries("employee-a")).toEqual([{ id: "canvas-a", revision: 2, deleted: true, summary: null, updatedAt: deleted.document.updatedAt }]);
  expect(reopened.put("employee-a", "missing", { baseRevision: 9, document: null }, () => true)).toEqual({ ok: false, document: { id: "missing", revision: 0, deleted: true, document: null, updatedAt: new Date(0).toISOString() } });
  expect(reopened.summaries("employee-a")).toHaveLength(1);
});

test("every referenced asset must be readable and rejected media leaves no stored document", () => {
  const store = open();
  const deniedAssetId = "2ae0016e-1237-4da6-a3bc-186651592ad5";
  const source = document();
  source.chatSessions[0]!.messages[0]!.attachments[0]!.url = `/api/assets/${deniedAssetId}/content`;
  expect(() => store.put("employee-a", source.id, { baseRevision: 0, document: source }, id => id === assetId)).toThrow("画布引用的素材不存在或无权访问");
  expect(store.summaries("employee-a")).toEqual([]);
});

test("browser-local media and local storage keys cannot be persisted as cloud documents", () => {
  const store = open();
  for (const media of ["blob:https://canvas.example/local", "data:image/png;base64,aGVsbG8="]) {
    expect(() => store.put("employee-a", "canvas-a", { baseRevision: 0, document: document("canvas-a", media) }, () => true)).toThrow(CanvasDocumentError);
  }
  const source = document();
  Object.assign(source.nodes[0]!.metadata, { storageKey: "image:browser-local" });
  expect(() => store.put("employee-a", "canvas-a", { baseRevision: 0, document: source }, () => true)).toThrow(CanvasDocumentError);
  expect(store.summaries("employee-a")).toEqual([]);
});

test("sixty large SQLite documents expose only small summaries and hydrate one exact compact document", () => {
  const store = open(":memory:");
  const summaries = new Map<string, ReturnType<typeof expectedCanvasSummary>>();
  let fullListBytes = Buffer.byteLength('{"documents":[]}');
  let selectedEnvelope: ReturnType<DemoCanvasDocumentStore["get"]> | undefined;
  for (let index = 0; index < 60; index++) {
    const source = largeCanvasDocument(`large-${String(index).padStart(2, "0")}`, assetId);
    const saved = store.put("employee-a", source.id, { baseRevision: 0, document: source }, id => id === assetId || id === compactHistoryAssetId);
    expect(saved.ok).toBe(true);
    summaries.set(source.id, expectedCanvasSummary(source));
    fullListBytes += Buffer.byteLength(JSON.stringify(saved.document)) + (index ? 1 : 0);
    if (index === 37) selectedEnvelope = saved.document;
  }
  const listed = store.summaries("employee-a");
  const text = JSON.stringify({ documents: listed });
  expect(listed).toHaveLength(60);
  expect(Buffer.byteLength(text)).toBeLessThan(64 * 1024);
  expect(Buffer.byteLength(text)).toBeLessThan(fullListBytes / 100);
  for (const item of listed) {
    expect(Object.keys(item).sort()).toEqual(["deleted", "id", "revision", "summary", "updatedAt"]);
    const expected = summaries.get(item.id);
    if (!expected) throw new Error(`Unexpected summary ID: ${item.id}`);
    expect(item.summary).toEqual(expected);
  }
  expect(text).not.toContain("PRIVATE-");
  expect(text).not.toContain("canvas-history-delta-v1");
  expect(store.get("employee-a", "large-37")).toEqual(selectedEnvelope!);
  expect(store.get("employee-a", "large-37").document).toEqual(largeCanvasDocument("large-37", assetId));
  expect(store.summaries("employee-b")).toEqual([]);
  expect(store.get("employee-b", "large-37")).toMatchObject({ revision: 0, deleted: true, document: null });
  console.log(JSON.stringify({ contract: "demo-canvas-summary", projects: 60, nodesPerProject: 5000, fullListBytes, summaryBytes: Buffer.byteLength(text), detailEqual: true }));
}, 30000);

test("compact history-only assets keep their permission and local-media checks before SQLite writes", () => {
  const store = open(":memory:");
  const source = largeCanvasDocument("compact-history", assetId, 12);
  const checkedAssets: string[] = [];
  expect(() => store.put("employee-a", source.id, { baseRevision: 0, document: source }, id => { checkedAssets.push(id); return id === assetId; })).toThrow("画布引用的素材不存在或无权访问");
  expect(checkedAssets).toEqual([assetId, compactHistoryAssetId]);
  expect(store.summaries("employee-a")).toEqual([]);
  const localHistory = { ...source, history: { format: source.history.format, past: [{ arrays: { nodes: { kind: "splice", start: 3, deleteCount: 1, items: [{ ...source.nodes[3], type: "image", metadata: { content: "blob:local-history" } }] } } }], future: [] } };
  expect(() => store.put("employee-a", source.id, { baseRevision: 0, document: localHistory }, () => true)).toThrow(CanvasDocumentError);
  expect(store.summaries("employee-a")).toEqual([]);
  const saved = store.put("employee-a", source.id, { baseRevision: 0, document: source }, () => true);
  expect(saved.ok).toBe(true);
  expect(store.get("employee-a", source.id).document).toEqual(source);
});
