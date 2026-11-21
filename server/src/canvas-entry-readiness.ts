import {CANVAS_USAGE_ENTRIES} from "../../shared/usage-analytics";
import type {Database} from "./db";

export async function canvasEntryReadiness(db:Pick<Database,"query">,asOf:Date){
    const keys=CANVAS_USAGE_ENTRIES.map(k=>"canvas_entry_open."+k),now=asOf.toISOString();
    const {rows}=await db.query<{key:string;clicks:number;people:number;days:number;lost:boolean;started:boolean;fromDay:string;untilDay:string}>(`
        WITH bounds AS (SELECT (date_trunc('day',$1::timestamptz AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') AS finish),
        entry_window AS MATERIALIZED (SELECT finish-interval '168 hours' AS start,finish FROM bounds),
        measured AS MATERIALIZED (SELECT control_key,user_id,occurred_at FROM usage_events,entry_window w
            WHERE board_key='canvas' AND action='open' AND control_key=ANY($2::text[]) AND occurred_at>=w.start AND occurred_at<w.finish AND received_at<=$1),
        coverage AS (SELECT count(DISTINCT (occurred_at AT TIME ZONE 'Asia/Shanghai')::date)::int AS days FROM measured)
        SELECT k.key,count(m.control_key)::int AS clicks,count(DISTINCT m.user_id)::int AS people,c.days,
            EXISTS(SELECT 1 FROM usage_events e WHERE e.action='gap' AND e.occurred_at>=w.start AND e.occurred_at<w.finish AND e.received_at<=$1) AS lost,
            EXISTS(SELECT 1 FROM usage_events e WHERE e.board_key='canvas' AND e.action='open' AND e.control_key='canvas_entry_open.prompt-dock' AND e.occurred_at<w.start AND e.received_at<=w.start) AS started,
            to_char(w.start AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS "fromDay",to_char(w.finish AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS "untilDay"
        FROM unnest($2::text[]) WITH ORDINALITY k(key,idx) CROSS JOIN entry_window w CROSS JOIN coverage c LEFT JOIN measured m ON m.control_key=k.key
        GROUP BY k.key,k.idx,w.start,w.finish,c.days ORDER BY k.idx`,[now,keys]);
    const c=rows[0]!;
    return {timezone:"Asia/Shanghai",fromInclusive:c.fromDay,untilExclusive:c.untilDay,observedDays:c.days,collectionGap:c.lost,allEntryTrackingObservedBeforeWindow:c.started,
        eligibleForManualReview:c.started&&c.days===7&&!c.lost,entries:rows.map(r=>({entry:r.key.slice("canvas_entry_open.".length),opens:r.clicks,distinctUsers:r.people})),
        action:"read-only; never hides an entry"};
}
