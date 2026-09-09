import { expect, test } from "bun:test";
import { createImageEditCopySession, imageCopyEditorNode } from "@/lib/image-edit-copy";
import type { Asset, AssetInput } from "@/stores/use-asset-store";

const source = {
    node: imageCopyEditorNode({ id: "original", title: "春日花型_v1.png", dataUrl: "blob:expired-original", storageKey: "image:original", width: 1200, height: 900, imageName: "春日花型", imageVersion: 1 }),
    sourceAssetId: "colleague-original", sourceTaskId: "task-1", tags: ["花型"], note: "客户原稿",
};
const uploaded = { url: "blob:edited", storageKey: "image:edited", width: 728, height: 90, bytes: 1234, mimeType: "image/png" };

test("editing uses original storage data and saves a new named version without modifying its source", () => {
    const before = structuredClone(source);
    const writes: AssetInput[] = [];
    const session = createImageEditCopySession(source, "designer-b");
    const result = session.save(uploaded, "designer-b", [], asset => { writes.push(asset); return "new-copy"; });
    expect(session.node.metadata).toMatchObject({ content: "blob:expired-original", storageKey: "image:original" });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ ownerId: "designer-b", title: "春日花型_v2", kind: "image", data: { storageKey: "image:edited", width: 728, height: 90 }, metadata: { imageName: "春日花型", imageVersion: 2, sourceAssetId: "colleague-original", sourceTaskId: "task-1" } });
    expect(writes[0]!.metadata?.serverAssetId).toBeUndefined();
    expect(result).toMatchObject({ assetId: "new-copy", node: { id: "new-copy", title: "春日花型_v2", metadata: { imageVersion: 2 } } });
    expect(source).toEqual(before);
});

test("repeated confirmation is idempotent and sibling copies advance the next version", () => {
    let writes = 0;
    const assets = [{ ownerId: "designer-b", metadata: { imageOriginId: "colleague-original", imageVersion: 4 } }] as Asset[];
    const session = createImageEditCopySession(source, "designer-b");
    const add = () => { writes++; return "copy-v5"; };
    const first = session.save(uploaded, "designer-b", assets, add);
    const second = session.save(uploaded, "designer-b", assets, add);
    expect(first.node.metadata?.imageVersion).toBe(5);
    expect(second).toBe(first);
    expect(writes).toBe(1);
});

test("account changes and closed sessions cannot insert an edited image", () => {
    let writes = 0;
    const add = () => { writes++; return "wrong-owner"; };
    const session = createImageEditCopySession(source, "designer-b");
    expect(() => session.save(uploaded, "designer-c", [], add)).toThrow("账号");
    session.invalidate();
    expect(() => session.save(uploaded, "designer-b", [], add)).toThrow("失效");
    expect(writes).toBe(0);
});
