import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { insertUsageEvents, usageBreakdowns, usageEventsSchema } from "../../src/usage-analytics";
import {canvasEntryReadiness} from "../../src/canvas-entry-readiness";

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
        const cutoff=new Date("2026-02-10T00:30:00+08:00"),dock="canvas_entry_open.prompt-dock";
        expect(usageEventsSchema.parse({events:[{...first,controlKey:dock}]}).events[0]!.controlKey).toBe(dock);
        const evidence=(d:string,k:string=dock,action="open",received=d)=>fixture.db.query("INSERT INTO usage_events(user_id,event_id,board_key,action,control_key,occurred_at,received_at) VALUES($1,$2,'canvas',$3,$4,$5,$6)",[owners[0],randomUUID(),action,k,d,received]);
        for(let day=3;day<=10;day++)await evidence("2026-02-"+String(day).padStart(2,"0")+"T00:01:00+08:00");
        const read=()=>canvasEntryReadiness(fixture.db,cutoff);
        const fresh=await read();expect(fresh).toMatchObject({eligibleForManualReview:false,fromInclusive:"2026-02-03",untilExclusive:"2026-02-10",observedDays:7});
        expect(fresh.entries).toHaveLength(12);expect(fresh.entries.find(e=>e.entry==="prompt-dock")).toMatchObject({opens:7,distinctUsers:1});
        await evidence("2026-02-02T23:50:00+08:00");expect((await read()).eligibleForManualReview).toBe(true);
        await evidence("2026-02-04T15:00:00+08:00","collection-gap","gap","2026-02-11T00:00:00+08:00");expect((await read()).collectionGap).toBe(false);
        await evidence("2026-02-05T15:00:00+08:00","collection-gap","gap");expect(await read()).toMatchObject({collectionGap:true,eligibleForManualReview:false});
    } finally { await fixture.close(); }
}, 30_000);
