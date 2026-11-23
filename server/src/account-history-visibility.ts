import type { HistoryKind } from "../../shared/history-removal";

export const historyRemovalAction = "account.history_removed";
export function visibleHistory(kind: HistoryKind, alias: string) {
    return `${alias}.id::text NOT IN (SELECT h.target_id FROM audit_logs h WHERE h.actor_user_id=$1 AND h.action='${historyRemovalAction}' AND h.target_type='history.${kind}' AND h.result='success' AND h.target_id IS NOT NULL)`;
}
