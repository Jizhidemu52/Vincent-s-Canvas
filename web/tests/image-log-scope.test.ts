import { describe, expect, test } from "bun:test";
import { partitionImageLogs } from "@/pages/image/image-log-scope";

const tools = ["image-generation", "detail-enhance", "image-edit", "angle-control"];
const scope = (tool: string) => ({ tool, ownerId: "designer-a" });

describe("image workbench history scope", () => {
    test("all four tools, accounts and creative scenes keep independent histories", async () => {
        const records = [...tools, "creative-local-restyle"].map(tool => ({ id: tool, tool, ownerId: "designer-a", images: [] }));
        records.push({ id: "other-owner", tool: "image-edit", ownerId: "designer-b", images: [] });
        for (const tool of [...tools, "creative-local-restyle"]) {
            const result = await partitionImageLogs(records, scope(tool), async () => { throw new Error("tagged logs need no server lookup"); });
            expect(result.logs.map(log => log.id)).toEqual([tool]);
            expect(result.unclassified).toEqual([]);
        }
    });

    test("existing images use their real task tool; querying does not mutate saved records", async () => {
        const records = tools.map(tool => ({ id: tool, images: [{ sourceTaskId: tool }, { sourceTaskId: tool }] }));
        const calls: string[] = [];
        const result = await partitionImageLogs(records, scope("image-edit"), async id => {
            calls.push(id);
            return { userId: "designer-a", parameters: { tool: id } };
        });
        expect(result.logs).toEqual([{ ...records[2], ...scope("image-edit") }]);
        expect(calls).toEqual(tools);
        expect(records.every(record => !("tool" in record))).toBe(true);
    });

    test("unknown, conflicting and failed lookups stay unclassified instead of leaking into a tool", async () => {
        const records = [
            { id: "no-task", images: [{}] }, { id: "failed-log", images: [] },
            { id: "mixed", images: [{ sourceTaskId: "edit" }, { sourceTaskId: "enhance" }] },
            { id: "partial", images: [{ sourceTaskId: "edit" }, {}] },
            { id: "missing", images: [{ sourceTaskId: "gone" }] },
            { id: "network", images: [{ sourceTaskId: "network" }] },
            { id: "other-owner", images: [{ sourceTaskId: "private" }] },
            { id: "current", tool: "image-edit", images: [] },
        ];
        const result = await partitionImageLogs(records, scope("image-edit"), async id => {
            if (id === "network") throw new Error("offline");
            if (id === "gone") return null;
            return { ownerUserId: id === "private" ? "designer-b" : "designer-a", parameters: { tool: id === "enhance" ? "detail-enhance" : "image-edit" } };
        });
        expect(result.logs.map(log => log.id)).toEqual(["current"]);
        expect(result.unclassified.map(log => log.id)).toEqual(["no-task", "failed-log", "mixed", "partial", "missing", "network"]);
        expect(records).toHaveLength(8);
    });
});
