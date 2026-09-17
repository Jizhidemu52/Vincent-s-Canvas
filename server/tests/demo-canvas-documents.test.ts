import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CanvasDocumentError } from "../src/canvas-document";
import { DemoCanvasDocumentStore } from "../src/demo-canvas-documents";

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
  const source = document();
  const saved = first.put("employee-a", source.id, { baseRevision: 0, document: source }, id => id === assetId);
  expect(saved).toMatchObject({ ok: true, document: { id: source.id, revision: 1, deleted: false, document: source } });
  const database = Reflect.get(first, "db") as Database;
  expect(database.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  expect(database.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
  connections.splice(connections.indexOf(first), 1); first.close();
  const reopened = open(path);
  expect(reopened.list("employee-a")).toEqual([saved.document]);
  const detached = reopened.list("employee-a");
  detached[0]!.document!.title = "changed only in caller";
  expect(reopened.list("employee-a")[0]!.document).toEqual(source);
});

test("the same document ID is independently owned by each employee", () => {
  const store = open();
  store.put("employee-a", "canvas-a", { baseRevision: 0, document: document() }, () => true);
  store.put("employee-b", "canvas-a", { baseRevision: 0, document: { ...document(), title: "乙的画布" } }, () => true);
  expect(store.list("employee-a").map(item => item.document?.title)).toEqual(["完整画布 · 原样保存"]);
  expect(store.list("employee-b").map(item => item.document?.title)).toEqual(["乙的画布"]);
  expect(store.list("unknown")).toEqual([]);
});

test("separate database connections use atomic CAS and return the exact winning version", () => {
  const path = databasePath(), a = open(path), b = open(path);
  a.put("employee-a", "canvas-a", { baseRevision: 0, document: document() }, () => true);
  const winner = b.put("employee-a", "canvas-a", { baseRevision: 1, document: { ...document(), title: "设备 B 已保存" } }, () => true);
  const rejected = a.put("employee-a", "canvas-a", { baseRevision: 1, document: { ...document(), title: "设备 A 旧版本" } }, () => true);
  expect(winner.document.revision).toBe(2);
  expect(rejected).toEqual({ ok: false, document: winner.document });
  expect(a.list("employee-a")).toEqual([winner.document]);
});

test("deletion creates a durable tombstone that stale or refreshed devices cannot revive", () => {
  const path = databasePath(), store = open(path);
  store.put("employee-a", "canvas-a", { baseRevision: 0, document: document() }, () => true);
  const deleted = store.put("employee-a", "canvas-a", { baseRevision: 1, document: null }, () => false);
  expect(deleted).toMatchObject({ ok: true, document: { id: "canvas-a", revision: 2, deleted: true, document: null } });
  const reopened = open(path);
  for (const baseRevision of [0, 1, 2]) expect(reopened.put("employee-a", "canvas-a", { baseRevision, document: document() }, () => true)).toEqual({ ok: false, document: deleted.document });
  expect(reopened.list("employee-a")).toEqual([deleted.document]);
  expect(reopened.put("employee-a", "missing", { baseRevision: 9, document: null }, () => true)).toEqual({ ok: false, document: { id: "missing", revision: 0, deleted: true, document: null, updatedAt: new Date(0).toISOString() } });
  expect(reopened.list("employee-a")).toHaveLength(1);
});

test("every referenced asset must be readable and rejected media leaves no stored document", () => {
  const store = open();
  const deniedAssetId = "2ae0016e-1237-4da6-a3bc-186651592ad5";
  const source = document();
  source.chatSessions[0]!.messages[0]!.attachments[0]!.url = `/api/assets/${deniedAssetId}/content`;
  expect(() => store.put("employee-a", source.id, { baseRevision: 0, document: source }, id => id === assetId)).toThrow("画布引用的素材不存在或无权访问");
  expect(store.list("employee-a")).toEqual([]);
});

test("browser-local media and local storage keys cannot be persisted as cloud documents", () => {
  const store = open();
  for (const media of ["blob:https://canvas.example/local", "data:image/png;base64,aGVsbG8="]) {
    expect(() => store.put("employee-a", "canvas-a", { baseRevision: 0, document: document("canvas-a", media) }, () => true)).toThrow(CanvasDocumentError);
  }
  const source = document();
  Object.assign(source.nodes[0]!.metadata, { storageKey: "image:browser-local" });
  expect(() => store.put("employee-a", "canvas-a", { baseRevision: 0, document: source }, () => true)).toThrow(CanvasDocumentError);
  expect(store.list("employee-a")).toEqual([]);
});
