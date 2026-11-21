import {z} from "zod";
import type {Database} from "./db";

const quick="t.request_id LIKE 'tryout:'||t.user_id::text||':%' AND t.tool_key='canvas-edit' AND t.operation_type='inpaint' AND t.parameters->>'tryoutTier'='quick'";
const stamp=z.number().int().min(1).max(4102444800000);
export const firstDisplay=z.strictObject({droppedAt:stamp,submittedAt:stamp,shownAt:stamp,source:z.enum(["preview","original"])}).refine(v=>v.droppedAt<=v.submittedAt&&v.submittedAt<=v.shownAt&&v.shownAt-v.droppedAt<=3600_000);

export async function noteFirstDisplay(db:Pick<Database,"query">,owner:string,id:string,data:z.infer<typeof firstDisplay>){
    await db.query(`UPDATE tasks t SET upstream_result_document=jsonb_set(t.upstream_result_document,'{display}', $3::jsonb || jsonb_build_object('observedAt',clock_timestamp()))
        WHERE t.id=$1 AND t.user_id=$2 AND ${quick} AND t.upstream_result_document->>'kind'='tryout-image'
        AND t.upstream_result_document ? 'finishedAt' AND NOT (t.upstream_result_document ? 'display')
        AND t.queued_at>=now()-interval '1 hour' AND (t.status='success' OR $4='preview' AND t.status IN ('processing','paused'))`,[id,owner,JSON.stringify(data),data.source]);
}

export async function tryoutSpeedReport(db:Pick<Database,"query">){
    const rows=(await db.query(`WITH samples AS (
        SELECT t.model_config_id,m.name,t.status,t.paused_kind,t.repair_error_code,
            extract(epoch FROM ((t.upstream_result_document->>'finishedAt')::timestamptz-t.upstream_submission_started_at))*1000 AS provider_ms,
            (d->>'shownAt')::bigint-(d->>'droppedAt')::bigint AS total_ms,
            (d->>'submittedAt')::bigint-(d->>'droppedAt')::bigint AS admission_ms,
            extract(epoch FROM ((d->>'observedAt')::timestamptz-(t.upstream_result_document->>'finishedAt')::timestamptz))*1000 AS display_ms
        FROM tasks t LEFT JOIN model_configs m ON m.id=t.model_config_id
        CROSS JOIN LATERAL (SELECT t.upstream_result_document->'display' AS d) obs
        WHERE ${quick} AND t.queued_at>=now()-interval '7 days'
    ) SELECT model_config_id AS "modelId",coalesce(name,'已移除的配置') AS name,count(*)::int AS tasks,
        count(*) FILTER(WHERE status='paused')::int AS paused,count(*) FILTER(WHERE status='failed')::int AS failed,
        count(*) FILTER(WHERE status='success')::int AS succeeded,
        ${["provider","total","admission","display"].flatMap(metric=>[
            `count(*) FILTER(WHERE ${metric}_ms>=0)::int AS "${metric}Samples"`,
            ...[50,90].map(p=>`round((percentile_cont(${p/100}) WITHIN GROUP (ORDER BY ${metric}_ms) FILTER (WHERE ${metric}_ms>=0))::numeric)::int AS "${metric}P${p}"`),
        ]).join(",")}
        FROM samples GROUP BY model_config_id,name ORDER BY count(*) DESC,model_config_id`)).rows;
    const issues=(await db.query(`SELECT t.model_config_id AS "modelId",t.status AS state,t.paused_kind AS kind,
        CASE WHEN t.repair_error_code ~ '^[A-Z][A-Z0-9_]{0,79}$' THEN t.repair_error_code ELSE NULL END AS code,
        NULLIF(trim(t.upstream_task_id),'') IS NOT NULL AS "hasUpstreamId",count(*)::int AS count
        FROM tasks t WHERE ${quick} AND t.queued_at>=now()-interval '7 days' AND t.status IN ('failed','paused')
        GROUP BY 1,2,3,4,5 ORDER BY count(*) DESC`)).rows;
    return {days:7,models:rows.map(m=>({...m,issues:issues.filter(i=>i.modelId===m.modelId)}))};
}
