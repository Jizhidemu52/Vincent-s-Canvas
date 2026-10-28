import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { test as base, expect, type BrowserContext, type Page, type Route } from "@playwright/test";
import { moduleDefinitions, toolDefinitions } from "../../shared/feature-catalog";

export const ORIGIN = "http://127.0.0.1:5199";
// A real 256px fixture keeps pointer handles and image previews usable. Built
// without an image package so CI has no additional native dependency.
function fixturePng(blue = 160) {
    const chunk = (type: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        let crc = 0xffffffff;
        for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
        const header = Buffer.alloc(4), checksum = Buffer.alloc(4);
        header.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        return Buffer.concat([header, body, checksum]);
    };
    const header = Buffer.alloc(13); header.writeUInt32BE(256, 0); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 2;
    const pixels = Buffer.alloc(256 * (256 * 3 + 1));
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        const offset = y * 769 + 1 + x * 3;
        pixels[offset] = x; pixels[offset + 1] = y; pixels[offset + 2] = blue;
    }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
export const IMAGE = fixturePng();
const OWNER = "00000000-0000-4000-8000-000000000099";
const MODEL = { id: "10000000-0000-4000-8000-000000000001", name: "E2E GPT Image", modelId: "gpt-image-2", providerName: "Isolated fixture", protocol: "openai", capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 };
type Json = Record<string, any>;
type CloudDocument = { id: string; revision: number; deleted: boolean; document: Json | null; updatedAt: string };

/** Stateful HTTP double. Test actions use the public UI; no app stores are injected. */
export class MockCanvasApi {
    constructor(private origin = ORIGIN) {}
    role: "designer" | "super_admin" | "department_admin" = "designer";
    documents = new Map<string, CloudDocument>();
    tasks = new Map<string, Json>();
    assets = new Map<string, Json>();
    assetBytes = new Map<string, Buffer>();
    submissions: Json[] = [];
    batchSubmissions: Json[] = [];
    batchActions: string[] = [];
    blocked: string[] = [];
    unexpected: string[] = [];
    pageErrors: string[] = [];
    conflicts = 0;
    batchId = "20000000-0000-4000-8000-000000000001";
    taskStatus = "success";
    taskReads: string[] = [];
    holdSession = false;
    private heldSessions: Route[] = [];
    holdWrites = false;
    private heldWrites: Array<{ route: Route; id: string; input: Json }> = [];

    async attach(context: BrowserContext) {
        context.on("page", page => page.on("pageerror", error => this.pageErrors.push(error.message)));
        for (const page of context.pages()) page.on("pageerror", error => this.pageErrors.push(error.message));
        await context.routeWebSocket("**/*", socket => socket.close());
        await context.route("**/*", route => this.route(route));
    }

    document(id: string) { return this.documents.get(id)?.document; }
    pendingWrites() { return this.heldWrites.length; }
    pendingSessions() { return this.heldSessions.length; }
    async releaseSessions() {
        this.holdSession = false;
        for (const route of this.heldSessions.splice(0)) await this.session(route);
    }
    async releaseWrites() {
        this.holdWrites = false;
        const pending = this.heldWrites.splice(0);
        for (const item of pending) await this.putDocument(item.route, item.id, item.input);
    }
    completeBatch() {
        for (const task of this.tasks.values()) if (task.batchId === this.batchId) {
            task.status = "success";
            task.resultUrls = [`/api/assets/${task.id}/content`];
        }
    }

    private json(route: Route, value: unknown, status = 200) {
        return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    }
    private session(route: Route) {
        return this.json(route, { user: { id: OWNER, username: "e2e", displayName: "隔离回归账号", role: this.role, departmentId: this.role === "department_admin" ? "department-e2e" : null, status: "active", mustChangePassword: false, creditBalance: 999 } });
    }
    private async putDocument(route: Route, id: string, input: Json) {
        const current = this.documents.get(id);
        if (input.baseRevision !== (current?.revision || 0)) {
            this.conflicts++;
            return this.json(route, { error: "CANVAS_REVISION_CONFLICT", document: current }, 409);
        }
        const next = { id, revision: (current?.revision || 0) + 1, deleted: !input.document, document: input.document, updatedAt: new Date().toISOString() };
        this.documents.set(id, next);
        const { document: _document, ...ack } = next;
        return this.json(route, { document: ack });
    }
    private async route(route: Route) {
        const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
        if (!["http:", "https:"].includes(url.protocol)) return route.continue();
        if (url.origin !== this.origin) { this.blocked.push(request.url()); return route.abort("blockedbyclient"); }
        if (!path.startsWith("/api/")) return route.continue();
        const json = (value: unknown, status = 200) => this.json(route, value, status);
        if (path === "/api/deployment") return json({ authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false });
        if (path === "/api/auth/session") {
            if (this.holdSession) { this.heldSessions.push(route); return; }
            return this.session(route);
        }
        if (path === "/api/modules") return json({ modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: true })) });
        if (path === "/api/models") return json({ models: [MODEL], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: MODEL.id, configurationVersion: 1 })) });
        if (path === "/api/canvas-documents") return json({ documents: [...this.documents.values()].map(({ document, ...record }) => ({ ...record, summary: document ? { id: document.id, title: document.title, createdAt: document.createdAt, updatedAt: document.updatedAt, nodeCount: document.nodes.length, connectionCount: document.connections.length, cover: null } : null })) });
        if (path.startsWith("/api/canvas-documents/")) {
            const id = decodeURIComponent(path.split("/").at(-1)!);
            if (method === "GET") return json({ document: this.documents.get(id) || { id, revision: 0, deleted: true, document: null, updatedAt: new Date().toISOString() } });
            if (method === "PUT") {
                const input = request.postDataJSON();
                if (this.holdWrites) { this.heldWrites.push({ route, id, input }); return; }
                return this.putDocument(route, id, input);
            }
        }
        if (path === "/api/projects/sync") {
            const input = request.postDataJSON();
            return json({ project: { id: input.externalId || randomUUID(), externalId: input.externalId, name: input.name, status: "active" } });
        }
        if (path === "/api/assets/upload-request") {
            const input = request.postDataJSON(), id = randomUUID();
            this.assets.set(id, { ...input, id, ownerUserId: OWNER, status: "ready", contentUrl: `/api/assets/${id}/content` });
            return json({ assetId: id, uploadUrl: `/api/e2e-upload/${id}` });
        }
        if (path.startsWith("/api/e2e-upload/")) {
            this.assetBytes.set(path.split("/").at(-1)!, request.postDataBuffer()!);
            return json({});
        }
        if (/^\/api\/assets\/[^/]+\/(content|thumb)$/.test(path)) return route.fulfill({ status: 200, contentType: "image/png", body: this.assetBytes.get(path.split("/")[3]) || IMAGE });
        if (/^\/api\/assets\/[^/]+$/.test(path)) return json({ asset: this.assets.get(path.split("/").at(-1)!) });
        if (path === "/api/tasks" && method === "POST") {
            const input = request.postDataJSON();
            this.submissions.push(input);
            const id = randomUUID(), task = { ...input, id, userId: OWNER, status: this.taskStatus, resultUrls: this.taskStatus === "success" ? [`/api/assets/${id}/content`] : [], failureReason: null, createdAt: new Date().toISOString() };
            this.assetBytes.set(id, fixturePng(40 + this.tasks.size * 40));
            this.assets.set(id, { id, ownerUserId: OWNER, status: "ready", mimeType: "image/png", contentUrl: `/api/assets/${id}/content` });
            this.tasks.set(id, task);
            return json({ task }, 201);
        }
        if (path === "/api/tasks/batch" && method === "POST") {
            const input = request.postDataJSON(); this.batchSubmissions.push(input);
            const tasks = input.items.map((item: Json, itemIndex: number) => {
                const task = { ...input, ...item, id: randomUUID(), userId: OWNER, itemIndex, batchId: this.batchId, status: "queued", resultUrls: [], failureReason: null, createdAt: new Date().toISOString() };
                this.tasks.set(task.id, task); return task;
            });
            return json({ batchId: this.batchId, tasks, failures: [] }, 201);
        }
        if (path.startsWith(`/api/tasks/batches/${this.batchId}/`)) {
            const action = path.split("/").at(-1)!; this.batchActions.push(action);
            for (const task of this.tasks.values()) if (task.batchId === this.batchId) task.status = action === "pause" ? "paused" : action === "resume" ? "queued" : "cancelled";
            return json({ changed: this.tasks.size });
        }
        if (path === "/api/tasks") return json({ tasks: [...this.tasks.values()], nextCursor: null });
        // Most tests exercise the supported GET fallback. The stream test
        // overrides this route with an isolated, real HTTP event stream.
        if (path === "/api/tasks/events") return json({ error: "FIXTURE_STREAM_DISABLED" }, 404);
        if (/^\/api\/tasks\/[^/]+$/.test(path)) {
            this.taskReads.push(path);
            return json({ task: this.tasks.get(path.split("/").at(-1)!) });
        }
        if (/^\/api\/tasks\/[^/]+\/progress$/.test(path)) return json({ progress: { status: "queued", phase: "waiting", runtime: "worker", queuePosition: 1 } });
        if (["/api/assets", "/api/assets/summary", "/api/projects", "/api/generation-history", "/api/history"].includes(path)) return json({ assets: [], projects: [], history: [], tasks: [], total: 0, hasMore: false, nextCursor: null });
        if (path.startsWith("/api/usage") || path.startsWith("/api/generation-history")) return json({ code: 0, data: [], history: [], total: 0 });
        this.unexpected.push(`${method} ${path}`);
        return json({ message: `Unmocked API: ${method} ${path}` }, 501);
    }
}

export const test = base.extend<{ api: MockCanvasApi }>({
    api: async ({ context }, use, testInfo) => {
        const api = new MockCanvasApi(testInfo.project.use.baseURL || ORIGIN);
        await api.attach(context);
        await use(api);
        expect(api.blocked, "No external requests are allowed").toEqual([]);
        expect(api.unexpected, "Every API is explicitly mocked").toEqual([]);
        expect(api.pageErrors, "No uncaught browser errors").toEqual([]);
    },
});
export { expect };

export async function newCanvas(page: Page) {
    await page.goto("/canvas");
    const create = page.getByRole("button", { name: "新建画布", exact: true }).first();
    await expect(create).toBeEnabled();
    await create.click();
    await expect(page).toHaveURL(/\/canvas\/[^/?]+$/);
    await expect(page.getByRole("button", { name: "上传素材", exact: true })).toBeVisible();
    return new URL(page.url()).pathname.split("/").at(-1)!;
}

export async function uploadImage(page: Page, name = "reference.png") {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传素材", exact: true }).click();
    await (await chooser).setFiles({ name, mimeType: "image/png", buffer: IMAGE });
}

export async function editText(page: Page, nodeId: string, text: string) {
    const node = page.locator(`[data-node-id="${nodeId}"]`);
    await node.click({ position: { x: 45, y: 75 } });
    await page.getByRole("button", { name: "编辑文本", exact: true }).click();
    const editor = node.locator("textarea:not([placeholder])");
    await editor.fill(text);
    await editor.press("Escape");
    await expect(node).toContainText(text);
}
