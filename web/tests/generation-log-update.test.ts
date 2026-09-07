import { expect, test } from "bun:test";
import { upsertGenerationLog } from "@/lib/generation-log-update";

test("completing an older task replaces it without changing chronological order or duplicating it", () => {
    const logs = [{ id: "new", createdAt: 30, status: "pending" }, { id: "old", createdAt: 10, status: "pending" }];
    const next = upsertGenerationLog(logs, { id: "old", createdAt: 10, status: "success" });
    expect(next.map((log) => log.id)).toEqual(["new", "old"]);
    expect(next[1].status).toBe("success");
    expect(logs[1].status).toBe("pending");
    expect(next[0]).toBe(logs[0]);
    expect(upsertGenerationLog(next, { id: "middle", createdAt: 20, status: "success" }).map((log) => log.id)).toEqual(["new", "middle", "old"]);
});
