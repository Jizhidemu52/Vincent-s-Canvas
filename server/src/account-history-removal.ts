import { historyKinds, historyRemoval, historyTerminalStates } from "../../shared/history-removal";
import { historyRemovalAction } from "./account-history-visibility";
import { activeTurnStates } from "../../shared/image-conversation-turn-state";
import { withTransaction } from "./db-transaction";
import type { Database } from "./db";
import { lockTaskAdmission } from "./tasks";
import type { SessionUser } from "./types";

export class HistoryRemovalError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}
export async function removeAccountHistory(db: Database, actor: Pick<SessionUser,"id"|"role"|"departmentId">, input: unknown) {
    const { entries } = historyRemoval.parse(input);
    await withTransaction(db, async client => {
        await lockTaskAdmission(client, actor.id);
        for (const kind of historyKinds) {
            const ids = entries.filter(item => item.kind === kind).map(item => item.id).sort();
            if (!ids.length) continue;
            const source = kind === "task" ? "tasks" : kind === "local" ? "assets" : "image_conversations";
            const owner = kind === "task" ? "user_id" : "owner_user_id";
            const eligible = kind === "local" ? " AND a.kind='image' AND a.source='import' AND a.status='ready' AND a.deleted_at IS NULL AND a.metadata->'localProcessing'->>'version'='1' AND EXISTS(SELECT 1 FROM audit_logs p WHERE p.actor_user_id=$1 AND p.target_type='asset' AND p.target_id=a.id::text AND p.action='asset.local_processing_archived' AND p.result='success')" : "";
            const owned = await client.query(`SELECT a.id FROM ${source} a WHERE a.${owner}=$1 AND a.id=ANY($2::uuid[])${eligible} ORDER BY a.id FOR UPDATE`, [actor.id, ids]);
            if (owned.rows.length !== ids.length) throw new HistoryRemovalError(404, "记录不存在或不属于当前账号，本次未移除");
            const unfinished = "(t.status::text<>ALL($3::text[]) OR COALESCE(t.result_document->>'status','') IN ('partial','persisting') OR EXISTS(SELECT 1 FROM credit_reservations r WHERE r.request_id=t.request_id AND r.user_id=$1 AND r.status='held'))";
            const pending = kind === "local" ? null : kind === "task"
                ? await client.query(`SELECT 1 FROM tasks t WHERE t.user_id=$1 AND t.id=ANY($2::uuid[]) AND ${unfinished} LIMIT 1`, [actor.id, ids, historyTerminalStates])
                : await client.query(`SELECT 1 FROM image_conversation_turns v WHERE v.owner_user_id=$1 AND v.conversation_id=ANY($2::uuid[]) AND (v.state=ANY($4::text[]) OR (v.state='detached' AND v.output_version_id IS NULL) OR EXISTS(SELECT 1 FROM tasks t WHERE t.user_id=$1 AND (t.id=v.task_id OR t.request_id='chat-video:'||v.id::text) AND ${unfinished})) LIMIT 1`, [actor.id, ids, historyTerminalStates, activeTurnStates]);
            if (pending?.rows.length) throw new HistoryRemovalError(409, "仍有任务正在运行或待核查，本次未移除任何记录");
            await client.query(`INSERT INTO audit_logs(actor_user_id,actor_role,department_id,action,target_type,target_id,result)
                SELECT $1,$2,$3,$4,$5,id::text,'success' FROM unnest($6::uuid[]) ids(id)
                WHERE NOT EXISTS(SELECT 1 FROM audit_logs h WHERE h.actor_user_id=$1 AND h.action=$4 AND h.target_type=$5 AND h.target_id=ids.id::text AND h.result='success')`,
                [actor.id, actor.role, actor.departmentId, historyRemovalAction, "history."+kind, ids]);
        }
    });
    return { removed: entries };
}
