import { expect, test } from "bun:test";
import { DemoAssetProjectStore } from "../src/demo-asset-projects";

test("demo project sync preserves UUIDs and isolates shared external IDs by owner", () => {
  const store = new DemoAssetProjectStore(":memory:");
  try {
    const first = store.sync("employee-a", { externalId: "canvas-1", name: "第一稿" });
    const renamed = store.sync("employee-a", { externalId: "canvas-1", name: "新名称" });
    const other = store.sync("employee-b", { externalId: "canvas-1", name: "员工B" });
    expect(renamed.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    expect(store.list("employee-a")).toEqual([renamed]);
    expect(store.owns("employee-a", other.id)).toBe(false);
    expect(store.owns("employee-a", first.id)).toBe(true);
  } finally { store.close(); }
});
