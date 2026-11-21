import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { insertUsageEvents, usageBreakdowns, usageEventsSchema } from "../../src/usage-analytics";

(process.env.PGLITE_RUNTIME_PATH ? test : test.skip)("menu opens count distinct employees separately from events and deduplicate offline retries", async () => {
    const fixture = await createIsolatedPostgres();
    try {
        const owners = [randomUUID(), randomUUID()];
        const key = "canvas_entry_open.quick-panel";
        const event = () => usageEventsSchema.parse({ events: [{ eventId: randomUUID(), occurredAt: new Date().toISOString(), boardKey: "canvas", action: "open", controlKey: key }] }).events[0]!;
        for (const owner of owners) await fixture.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,$2,'QA','designer')", [owner, owner]);
        const first = event();
        await insertUsageEvents(fixture.db, owners[0]!, [first, event()]);
        expect(await insertUsageEvents(fixture.db, owners[0]!, [first])).toMatchObject({ accepted: 0, duplicates: 1 });
        await insertUsageEvents(fixture.db, owners[1]!, [event()]);
        expect((await usageBreakdowns(fixture.db, { boardKey: "canvas" })).controls).toContainEqual({ key, label: "画布入口 · quick-panel", count: 3, uniqueUsers: 2 });
        expect((await usageBreakdowns(fixture.db, { userIds: [owners[0]!] })).controls[0]).toMatchObject({ count: 2, uniqueUsers: 1 });
    } finally { await fixture.close(); }
}, 30_000);
