import { expect, test } from "bun:test";
import { createPersonalWorkspaceServer, workspaceFixtureUsers as users, workspaceVideoModel } from "../helpers/personal-workspace-server";

(process.env.PGLITE_RUNTIME_PATH ? test : test.skip)("personal super-admin workspace uses real sessions, own persistence, normal preflight and unchanged role boundaries", async () => {
    const h = await createPersonalWorkspaceServer();
    const request = (name: keyof typeof users, path: string, method = "GET", body?: unknown, owner = users[name]) => fetch(h.origin + path, {
        method, headers: { cookie: `workspace-fixture=fixture-${name}`, "content-type": "application/json", "X-Canvas-Owner-Id": owner },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const document = { id: "same-project", title: "个人画布", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: true, viewport: { x: 0, y: 0, k: 1 } };
    try {
        for (const name of ["admin", "designer"] as const) {
            expect((await request(name, "/api/canvas-documents/same-project", "PUT", { baseRevision: 0, document: { ...document, title: name } })).status).toBe(200);
            expect((await request(name, "/api/projects/sync", "POST", { externalId: "same-project", name })).status).toBe(200);
            const asset = await request(name, "/api/assets/upload-request", "POST", { filename: `${name}.txt`, mimeType: "text/plain", byteSize: 3, kind: "text" });
            expect(asset.status).toBe(201);
            const { assetId, uploadUrl } = await asset.json();
            const uploaded = await fetch(h.origin + uploadUrl, { method: "PUT", headers: { cookie: `workspace-fixture=fixture-${name}`, "content-type": "text/plain", "X-Canvas-Owner-Id": users[name] }, body: "own" });
            expect(uploaded.status).toBe(204);
            expect((await h.db.query("SELECT owner_user_id,status FROM assets WHERE id=$1", [assetId])).rows[0]).toMatchObject({ owner_user_id: users[name], status: "ready" });
            expect((await (await request(name, "/api/canvas-documents/same-project")).json()).document.document.title).toBe(name);
            const preflight = await request(name, "/api/tasks/preflight", "POST", { requestId: `preflight-${name}`, projectId: "same-project", operationType: "video_generation", modelConfigId: workspaceVideoModel, prompt: "A quiet landscape", parameters: { videoMode: "text" }, sourceUrls: [] });
            expect(await preflight.json()).toMatchObject({ ok: true });
            expect(preflight.status).toBe(200);
        }
        for (const path of ["/api/canvas-documents", "/api/projects", "/api/tasks", "/api/assets", "/api/models"]) {
            expect((await request("department", path)).status).toBe(401);
            expect((await request("localDesigner", path)).status).toBe(401);
        }
        const writesBefore = (await h.db.query("SELECT count(*)::int AS n FROM projects")).rows[0].n;
        expect((await request("admin", "/api/projects/sync", "POST", { externalId: "wrong-owner", name: "not saved" }, users.designer)).status).toBe(403);
        expect((await request("admin", "/api/assets/upload-request", "POST", { filename: "bad.txt", mimeType: "text/plain", byteSize: 3 }, users.designer)).status).toBe(403);
        expect((await request("admin", "/api/canvas-documents/same-project", "PUT", { baseRevision: 1, document }, users.designer)).status).toBe(403);
        expect((await h.db.query("SELECT count(*)::int AS n FROM projects")).rows[0].n).toBe(writesBefore);
        expect((await request("admin", "/api/admin/accounts")).status).toBe(200);
        expect((await request("designer", "/api/admin/accounts")).status).toBe(403);
        await h.db.query("UPDATE users SET must_change_password=true WHERE id=$1", [users.admin]);
        expect((await request("admin", "/api/projects")).status).toBe(403);
        expect((await h.db.query("SELECT count(*)::int AS n FROM tasks")).rows[0].n).toBe(0);
        expect((await h.db.query("SELECT count(*)::int AS n FROM credit_reservations")).rows[0].n).toBe(0);
        expect((await h.db.query("SELECT count(*)::int AS n FROM credit_ledger")).rows[0].n).toBe(0);
    } finally { await h.close(); }
}, 45_000);
