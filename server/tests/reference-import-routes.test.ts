import { expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Database } from "../src/db";
import { requireSameOrigin } from "../src/http-security";
import { createReferenceImportRouter, readReferenceImportBody, referenceImportBodyErrors } from "../src/routes/reference-import";

test("public-page capture rejects missing/mismatched owner, cross-site, disabled module and arbitrary image URLs before network work", async () => {
    let enabled = true;
    const calls: unknown[][] = [];
    const db = { query: async () => ({ rows: [{ enabled }] }) } as unknown as Database;
    const scan = { scanId: "scan-a", pageUrl: "https://public.example/catalog", pageTitle: "服装", candidates: [{ id: "image-a", name: "款式", sourceImage: "https://public.example/a.png" }], expiresAt: "2099-01-01T00:00:00.000Z", warnings: [] };
    const image = { id: "image-a", name: "款式.png", mime: "image/png", base64: "iVBORw0KGgo=", sourcePage: scan.pageUrl, sourceImage: scan.candidates[0]!.sourceImage, pageTitle: scan.pageTitle };
    const service = {
        scan: async (...args: unknown[]) => { calls.push(args.slice(0, 2)); return scan; },
        image: async (...args: unknown[]) => { calls.push(args.slice(0, 3)); return image; },
    };
    const app = express();
    app.use(express.json({ limit: "16kb" }), referenceImportBodyErrors, requireSameOrigin);
    app.use((request, _response, next) => { if (request.get("x-test-session") === "a") Object.assign(request, { auth: { id: "employee-a" } }); next(); });
    app.use("/api/reference-import", createReferenceImportRouter(db, service));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(done => server.once("listening", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (action: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${origin}/api/reference-import/${action}`, { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
    const headers = { "x-test-session": "a", "X-Canvas-Owner-Id": "employee-a" };
    try {
        expect((await post("scan", { url: scan.pageUrl })).status).toBe(401);
        expect((await post("scan", { url: scan.pageUrl }, { "x-test-session": "a" })).status).toBe(403);
        expect((await post("scan", { url: scan.pageUrl }, { ...headers, "X-Canvas-Owner-Id": "employee-b" })).status).toBe(403);
        expect((await post("scan", { url: scan.pageUrl }, { ...headers, origin: "https://other.example" })).status).toBe(403);
        enabled = false;
        expect((await post("scan", { url: scan.pageUrl }, headers)).status).toBe(403);
        enabled = true;
        expect((await post("image", { scanId: "scan-a", imageId: "image-a", url: "http://127.0.0.1" }, headers)).status).toBe(400);
        expect((await post("scan", { url: scan.pageUrl, ownerId: "employee-b" }, headers)).status).toBe(400);
        expect((await post("scan", { url: "x".repeat(20000) }, headers)).status).toBe(413);
        expect(calls).toEqual([]);
        const response = await post("scan", { url: scan.pageUrl }, headers);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({ code: 0, data: scan, msg: "" });
        expect(calls).toEqual([["employee-a", scan.pageUrl]]);
        expect(await (await post("image", { scanId: "scan-a", imageId: "image-a" }, headers)).json()).toEqual({ code: 0, data: image, msg: "" });
        expect(calls[1]).toEqual(["employee-a", "scan-a", "image-a"]);
    } finally { await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }); }
});

test("local Bun request parser bounds chunked JSON, rejects non-JSON and preserves URL query only for fetching", async () => {
    const make = (body: BodyInit, type = "application/json") => new Request("http://canvas.test/api/reference-import/scan", { method: "POST", headers: { "content-type": type }, body });
    expect(await readReferenceImportBody(make('{"url":"https://public.example/?view=1"}'))).toEqual({ url: "https://public.example/?view=1" });
    await expect(readReferenceImportBody(make("{}", "text/plain"))).rejects.toMatchObject({ status: 415 });
    await expect(readReferenceImportBody(make("{"))).rejects.toMatchObject({ status: 400 });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(8192)); }, cancel() { cancelled = true; } });
    await expect(readReferenceImportBody(make(stream))).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
});
