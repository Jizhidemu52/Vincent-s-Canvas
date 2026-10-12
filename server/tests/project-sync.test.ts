import { expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Database } from "../src/db";
import type { AuthenticatedRequest } from "../src/types";
import { createProjectsRouter } from "../src/routes/projects";

test("project sync avoids unchanged writes while returning the existing owner-scoped project and membership", async () => {
    const projects = new Map<string, { id: string; externalId: string; name: string; status: string; revision: number }>();
    const members = new Set<string>();
    let writes = 0;
    let unchangedReads = 0;
    const db = { query: async (sql: string, args: unknown[] = []) => {
        if (sql.includes("INSERT INTO projects")) {
            expect(sql).toContain("ON CONFLICT(owner_user_id,external_id)");
            expect(sql).toContain("WHERE projects.name IS DISTINCT FROM EXCLUDED.name");
            const [externalId, name, owner] = args as string[];
            const key = `${owner}:${externalId}`;
            const existing = projects.get(key);
            if (existing?.name === name) return { rows: [] };
            const project = { id: existing?.id || crypto.randomUUID(), externalId, name, status: "active", revision: (existing?.revision || 0) + 1 };
            projects.set(key, project); writes++;
            const { revision: _revision, ...returned } = project;
            return { rows: [returned] };
        }
        if (sql.includes("FROM projects")) {
            expect(sql).toContain("WHERE owner_user_id=$1 AND external_id=$2");
            unchangedReads++;
            const project = projects.get(`${args[0]}:${args[1]}`);
            if (!project) return { rows: [] };
            const { revision: _revision, ...returned } = project;
            return { rows: [returned] };
        }
        if (sql.includes("INSERT INTO project_members")) {
            expect(sql).toContain("ON CONFLICT DO NOTHING");
            members.add(`${args[0]}:${args[1]}`);
            return { rows: [] };
        }
        throw new Error("Unexpected project query");
    } } as unknown as Database;
    const app = express().use(express.json());
    app.use((request, _response, next) => {
        (request as AuthenticatedRequest).auth = { id: String(request.headers["x-test-owner"] || "employee-a"), departmentId: null } as never;
        next();
    });
    app.use("/api/projects", createProjectsRouter(db));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(done => server.once("listening", done));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/sync`;
    const sync = async (owner: string, name: string) => {
        const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-test-owner": owner }, body: JSON.stringify({ externalId: "canvas-id", name }) });
        expect(response.status).toBe(200);
        return response.json() as Promise<{ project: { id: string; externalId: string; name: string; status: string } }>;
    };
    try {
        const original = await sync("employee-a", "初稿");
        expect(original.project).toMatchObject({ externalId: "canvas-id", name: "初稿", status: "active" });
        expect(await sync("employee-a", " 初稿 ")).toEqual(original);
        expect(writes).toBe(1);
        expect(unchangedReads).toBe(1);
        expect(projects.get("employee-a:canvas-id")?.revision).toBe(1);
        const renamed = await sync("employee-a", "新名称");
        expect(renamed.project).toMatchObject({ ...original.project, name: "新名称" });
        expect(writes).toBe(2);
        const other = await sync("employee-b", "新名称");
        expect(other.project.id).not.toBe(original.project.id);
        expect(await sync("employee-b", "新名称")).toEqual(other);
        expect(writes).toBe(3);
        expect(unchangedReads).toBe(2);
        expect(members).toEqual(new Set([`${original.project.id}:employee-a`, `${other.project.id}:employee-b`]));
    } finally {
        await new Promise<void>((done, reject) => {
            server.close(error => error ? reject(error) : done());
            server.closeAllConnections();
        });
    }
});
