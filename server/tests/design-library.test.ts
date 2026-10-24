import { expect, test } from "bun:test";
import { inspectDesignLibraryImage } from "../src/design-library";
import { administrator, employee, gif, jpeg, libraryFixture, png, publishInput, uuid, webp } from "./design-library-fixtures";

test("accepted image snapshots use real format headers and dimensions, rejecting SVG, mismatches and broken containers", () => {
    for (const [bytes, mimeType] of [[png, "image/png"], [jpeg, "image/jpeg"], [gif, "image/gif"], [webp, "image/webp"]] as const) {
        expect(inspectDesignLibraryImage(bytes, mimeType)).toEqual({ mimeType, width: 1, height: 1 });
        expect(() => inspectDesignLibraryImage(bytes, "image/svg+xml")).toThrow();
        expect(() => inspectDesignLibraryImage(bytes.slice(0, 10), mimeType)).toThrow();
    }
    expect(() => inspectDesignLibraryImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/png")).toThrow();
    expect(() => inspectDesignLibraryImage(new Uint8Array(20 * 1024 * 1024 + 1), "image/png")).toThrow();
});

test("PG adapter executes publication, filters, ownership, source-independent snapshot and idempotency SQL", async () => {
    const h = libraryFixture();
    try {
        const author = h.actor(employee(1)); const viewer = h.actor(employee(2));
        const sourceId = uuid(10); const privateKey = h.source(sourceId, author);
        const input = publishInput([sourceId]);
        const [entry, repeated] = await Promise.all([h.service.publish(author, input), h.service.publish(author, input)]);
        expect(repeated.id).toBe(entry.id);
        expect(h.writes.filter(key => !key.endsWith(".library-thumb-256-v1.webp"))).toHaveLength(1);
        expect(h.writes.filter(key => key.endsWith(".library-thumb-256-v1.webp"))).toHaveLength(1);
        expect(entry.images[0]?.filename).toBe("原始设计.png");
        expect(entry.images[0]?.width).toBe(1);
        expect(entry.canViewStats).toBe(true);
        const wire = JSON.stringify(await h.service.detail(viewer, entry.id));
        for (const secret of [privateKey, sourceId, "objectKey", "secret-canvas", "private chat", "私有生成提示词"]) expect(wire).not.toContain(secret);
        expect(JSON.parse(wire).canViewStats).toBe(false);
        expect(await h.service.list(viewer, { q: "针织", tag: "春季" })).toMatchObject({ total: 1 });
        expect(await h.service.list(viewer, { q: "%" })).toMatchObject({ total: 0 });
        expect(await h.service.list(viewer, { tag: "其他" })).toMatchObject({ total: 0 });
        expect(await h.service.list(viewer, { scope: "mine" })).toMatchObject({ total: 0 });
        await expect(h.service.list(viewer, { scope: "all" })).rejects.toMatchObject({ status: 403 });
        await expect(h.service.publish(author, { ...input, prompt: "changed" })).rejects.toMatchObject({ status: 409 });
        h.objects.delete(privateKey);
        h.sqlite.query("UPDATE assets SET deleted_at='deleted' WHERE id=?").run(sourceId);
        expect((await h.service.image(viewer, entry.id, entry.images[0]!.id)).bytes).toEqual(png);
        expect(h.sqlite.query("SELECT visibility_scope FROM assets WHERE id=?").get(sourceId)).toEqual({ visibility_scope: "private" });
        const stats = await h.service.stats(author, entry.id, {});
        expect(stats.totals.view).toEqual({ count: 0, people: 0 });
        expect(h.queries.some(query => query.sql.includes("pg_advisory_xact_lock"))).toBe(true);
    } finally { h.close(); }
});

test("publishing enforces own ready originals, quotas, schema and failure cleanup without revealing source metadata", async () => {
    const h = libraryFixture();
    try {
        const author = h.actor(employee(1)); const other = h.actor(employee(2));
        h.source(uuid(10), other);
        h.source(uuid(11), author, png, { status: "pending" });
        h.source(uuid(12), author, png, { deleted: true });
        h.source(uuid(13), author, png, { byteSize: 20 * 1024 * 1024 + 1 });
        h.source(uuid(14), author, png, { mimeType: "image/svg+xml" });
        h.source(uuid(15), author, png, { byteSize: png.byteLength + 1 });
        for (const id of [10, 11, 12, 13, 14, 15]) await expect(h.service.publish(author, publishInput([uuid(id)], `invalid-${id}`))).rejects.toThrow();
        expect(h.writes).toEqual([]);
        for (let index = 20; index < 26; index++) h.source(uuid(index), author, png, { byteSize: 20 * 1024 * 1024 });
        await expect(h.service.publish(author, publishInput(Array.from({ length: 6 }, (_, index) => uuid(index + 20)), "too-large-publication"))).rejects.toMatchObject({ status: 413 });
        expect(h.writes).toEqual([]);
        await expect(h.service.publish(author, { ...publishInput(), thought: "", prompt: "" })).rejects.toThrow();
        await expect(h.service.publish(author, { ...publishInput(), actorId: other.id })).rejects.toThrow();
        await expect(h.service.publish(author, { ...publishInput(), title: "x".repeat(121) })).rejects.toThrow();
        h.source(uuid(30), author);
        h.failWrites(true);
        await expect(h.service.publish(author, publishInput([uuid(30)], "failed-write"))).rejects.toThrow("Simulated object write failure");
        expect(h.removed).toEqual(h.writes);
        expect(await h.service.list(author, { scope: "mine" })).toMatchObject({ total: 0 });
        h.failWrites(false);
        expect((await h.service.publish(author, publishInput([uuid(30)], "failed-write"))).status).toBe("published");
    } finally { h.close(); }
});

test("receipts use real SQL counts/UV, private actor identity and issued delivery lineage, never author actions", async () => {
    const h = libraryFixture();
    try {
        const author = h.actor(employee(1)); const b = h.actor(employee(2)); const c = h.actor(employee(3, 2));
        h.source(uuid(10), author); h.source(uuid(11), author);
        const entry = await h.service.publish(author, publishInput([uuid(10), uuid(11)]));
        const first = entry.images[0]!.id; const second = entry.images[1]!.id;
        expect(await h.service.receipt(author, entry.id, { action: "view", requestId: "author-view" })).toEqual({ recorded: false });
        for (const requestId of ["view-once", "view-once", "view-twice"]) await h.service.receipt(b, entry.id, { action: "view", requestId });
        await h.service.receipt(c, entry.id, { action: "view", requestId: "other-view" });
        await h.service.receipt(b, entry.id, { action: "view", imageId: first, requestId: "image-view" });
        await h.service.receipt(b, entry.id, { action: "prompt_copy", requestId: "prompt-copy" });
        await expect(h.service.receipt(b, entry.id, { action: "download", imageId: first, requestId: "unissued-download" })).rejects.toMatchObject({ status: 409 });
        for (const [imageId, requestId] of [[first, "download-1"], [second, "download-2"], [first, "download-3"]]) {
            expect((await h.service.download(b, entry.id, imageId!, { requestId })).bytes).toEqual(png);
            expect(await h.service.receipt(b, entry.id, { action: "download", imageId, requestId })).toEqual({ recorded: true });
            expect(await h.service.receipt(b, entry.id, { action: "download", imageId, requestId })).toEqual({ recorded: false });
        }
        const copyInput = { requestId: "reuse-original" };
        const [copy, duplicate] = await Promise.all([h.service.reuse(b, entry.id, first, copyInput), h.service.reuse(b, entry.id, first, copyInput)]);
        expect(copy.assetId).toBe(duplicate.assetId);
        expect(copy.image.id).toBe(first);
        expect(copy.image.contentUrl).toBe(`/api/assets/${copy.assetId}/content`);
        const asset = h.sqlite.query("SELECT owner_user_id,visibility_scope,metadata,object_key FROM assets WHERE id=?").get(copy.assetId) as any;
        expect(asset.owner_user_id).toBe(b.id);
        expect(asset.visibility_scope).toBe("private");
        expect(h.objects.get(asset.object_key)).toEqual(png);
        expect(JSON.parse(asset.metadata).designLibrarySource).toEqual(copy.source);
        await expect(h.service.receipt(c, entry.id, { action: "reuse", imageId: first, reusedAssetId: copy.assetId, ...copyInput })).rejects.toMatchObject({ status: 409 });
        await expect(h.service.receipt(b, entry.id, { action: "reuse", imageId: first, reusedAssetId: uuid(10), ...copyInput })).rejects.toMatchObject({ status: 409 });
        await h.service.receipt(b, entry.id, { action: "reuse", imageId: first, reusedAssetId: copy.assetId, ...copyInput });
        await expect(h.service.receipt(b, entry.id, { action: "view", requestId: "spoofed-name", actorName: "管理员" })).rejects.toThrow();
        const stats = await h.service.stats(author, entry.id, { page: 1, pageSize: 2 });
        expect(stats.totals).toEqual({ view: { count: 3, people: 2 }, download: { count: 3, people: 1 }, reuse: { count: 1, people: 1 }, prompt_copy: { count: 1, people: 1 } });
        expect(stats.images[0]?.counts).toEqual({ view: { count: 1, people: 1 }, download: { count: 2, people: 1 }, reuse: { count: 1, people: 1 }, prompt_copy: { count: 0, people: 0 } });
        expect(stats.images[1]?.counts.download).toEqual({ count: 1, people: 1 });
        expect(stats.activityTotal).toBe(4); expect(stats.activity).toHaveLength(2);
        expect(stats.activity.every(item => item.actor.id === b.id && item.actor.name === b.name && item.actor.departmentName === b.departmentName)).toBe(true);
        expect(stats.activity.every(item => item.action === "download" || item.action === "reuse")).toBe(true);
        expect(JSON.stringify(stats)).not.toContain("privateCanvas");
        await expect(h.service.stats(b, entry.id, {})).rejects.toMatchObject({ status: 403 });
        await expect(h.service.stats(h.actor(administrator(5, 2)), entry.id, {})).rejects.toMatchObject({ status: 403 });
        expect((await h.service.stats(h.actor(administrator(4, 1)), entry.id, {})).totals).toEqual(stats.totals);
    } finally { h.close(); }
});

test("withdrawal and scoped moderation deny new copies/downloads while allowing issued receipts and owner previews", async () => {
    const h = libraryFixture();
    try {
        const author = h.actor(employee(1)); const viewer = h.actor(employee(2));
        const ownAdmin = h.actor(administrator(3, 1)); const otherAdmin = h.actor(administrator(4, 2)); const superAdmin = h.actor(administrator(5));
        h.source(uuid(10), author);
        const entry = await h.service.publish(author, publishInput([uuid(10)]));
        const imageId = entry.images[0]!.id;
        await h.service.download(viewer, entry.id, imageId, { requestId: "inflight-download" });
        const reuse = await h.service.reuse(viewer, entry.id, imageId, { requestId: "inflight-reuse" });
        await expect(h.service.withdraw(viewer, entry.id)).rejects.toMatchObject({ status: 404 });
        expect((await h.service.withdraw(author, entry.id)).status).toBe("withdrawn");
        expect((await h.service.withdraw(author, entry.id)).status).toBe("withdrawn");
        expect(await h.service.list(viewer, {})).toMatchObject({ total: 0 });
        expect(await h.service.list(author, { scope: "mine" })).toMatchObject({ total: 1 });
        await expect(h.service.detail(viewer, entry.id)).rejects.toMatchObject({ status: 404 });
        await expect(h.service.image(viewer, entry.id, imageId)).rejects.toMatchObject({ status: 404 });
        expect((await h.service.image(author, entry.id, imageId)).bytes).toEqual(png);
        await expect(h.service.download(viewer, entry.id, imageId, { requestId: "inflight-download" })).rejects.toMatchObject({ status: 409 });
        await expect(h.service.reuse(viewer, entry.id, imageId, { requestId: "inflight-reuse" })).rejects.toMatchObject({ status: 409 });
        await expect(h.service.receipt(viewer, entry.id, { action: "view", requestId: "new-view-after-withdraw" })).rejects.toMatchObject({ status: 409 });
        expect(await h.service.receipt(viewer, entry.id, { action: "download", imageId, requestId: "inflight-download" })).toEqual({ recorded: true });
        expect(await h.service.receipt(viewer, entry.id, { action: "reuse", imageId, reusedAssetId: reuse.assetId, requestId: "inflight-reuse" })).toEqual({ recorded: true });
        expect(await h.service.list(otherAdmin, { scope: "all" })).toMatchObject({ total: 0 });
        expect(await h.service.list(ownAdmin, { scope: "all" })).toMatchObject({ total: 1 });
        expect(await h.service.list(superAdmin, { scope: "all" })).toMatchObject({ total: 1 });
        await expect(h.service.moderate(otherAdmin, entry.id, { reason: "越权" })).rejects.toMatchObject({ status: 403 });
        expect((await h.service.moderate(ownAdmin, entry.id, { reason: "包含未公开客户设计" })).status).toBe("taken_down");
        await expect(h.service.withdraw(author, entry.id)).rejects.toMatchObject({ status: 409 });
        expect(h.sqlite.query("SELECT action,actor_user_id,detail FROM audit_logs").all()).toEqual([{ action: "design_library.taken_down", actor_user_id: ownAdmin.id, detail: JSON.stringify({ reason: "包含未公开客户设计" }) }]);
        expect((await h.service.detail(author, entry.id)).canWithdraw).toBe(false);
    } finally { h.close(); }
});

test("failed private-asset persistence removes only the attempted copy and never adds a receipt", async () => {
    const h = libraryFixture();
    try {
        const author = h.actor(employee(1)); const viewer = h.actor(employee(2));
        const privateKey = h.source(uuid(10), author);
        const entry = await h.service.publish(author, publishInput([uuid(10)]));
        h.sqlite.exec("CREATE TRIGGER reject_library_copy BEFORE INSERT ON assets WHEN NEW.source='import' BEGIN SELECT RAISE(ABORT,'test persistence failure'); END;");
        await expect(h.service.reuse(viewer, entry.id, entry.images[0]!.id, { requestId: "failed-copy-persistence" })).rejects.toThrow("test persistence failure");
        expect(h.objects.has(privateKey)).toBe(true);
        expect(h.objects.has(h.writes[0]!)).toBe(true);
        const attemptedCopy = h.writes.find(key => key.startsWith(`users/${viewer.id}/`))!;
        expect(h.removed).toEqual([attemptedCopy]);
        expect(h.objects.has(attemptedCopy)).toBe(false);
        expect(h.objects.has(h.writes.find(key => key.endsWith(".library-thumb-256-v1.webp"))!)).toBe(true);
        expect(h.sqlite.query("SELECT count(*) AS count FROM design_library_deliveries").get()).toEqual({ count: 0 });
        expect((await h.service.stats(author, entry.id, {})).totals.reuse).toEqual({ count: 0, people: 0 });
        h.sqlite.exec("DROP TRIGGER reject_library_copy");
        expect((await h.service.reuse(viewer, entry.id, entry.images[0]!.id, { requestId: "failed-copy-persistence" })).assetId).toBeTruthy();
    } finally { h.close(); }
});

test("a lost commit acknowledgement recovers durable publication/reuse without deleting their original bytes", async () => {
    const h = libraryFixture();
    try {
        const author = h.actor(employee(1)); const viewer = h.actor(employee(2));
        h.source(uuid(10), author);
        const transaction = h.repository.transaction.bind(h.repository);
        h.repository.transaction = async work => { await transaction(work); throw new Error("Lost COMMIT acknowledgement"); };
        const entry = await h.service.publish(author, publishInput([uuid(10)]));
        expect(entry.status).toBe("published");
        expect(h.removed).toEqual([]);
        const copy = await h.service.reuse(viewer, entry.id, entry.images[0]!.id, { requestId: "committed-copy" });
        expect(h.removed).toEqual([]);
        expect(h.writes).toHaveLength(3);
        for (const key of h.writes.filter(key => !key.endsWith(".library-thumb-256-v1.webp"))) expect(h.objects.get(key)).toEqual(png);
        expect(inspectDesignLibraryImage(h.objects.get(h.writes.find(key => key.endsWith(".library-thumb-256-v1.webp"))!)!, "image/webp").width).toBe(1);
        expect((await h.repository.getSourceAsset(copy.assetId, viewer.id))?.ownerId).toBe(viewer.id);
        expect((await h.service.stats(author, entry.id, {})).totals.reuse).toEqual({ count: 0, people: 0 });
    } finally { h.close(); }
});
