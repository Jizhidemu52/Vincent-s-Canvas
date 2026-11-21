ALTER TABLE tasks
  ADD COLUMN paused_kind text CHECK (paused_kind IN ('result_repair','awaiting_query','submission_unknown','needs_review')),
  ADD COLUMN repair_attempts integer NOT NULL DEFAULT 0 CHECK (repair_attempts >= 0),
  ADD COLUMN next_repair_at timestamptz,
  ADD COLUMN repair_error_code text;

CREATE INDEX tasks_repair_due ON tasks(next_repair_at,id)
  WHERE status='paused' AND paused_kind IN ('result_repair','awaiting_query') AND next_repair_at IS NOT NULL;

WITH classified AS (
  SELECT id, CASE
    WHEN nullif(btrim(upstream_task_id),'') IS NULL THEN
      CASE WHEN upstream_submission_started_at IS NOT NULL THEN 'submission_unknown' ELSE 'needs_review' END
    WHEN failure_reason LIKE '渠道原件已保存到素材库，但图片后处理未完成%'
      AND failure_reason !~* 'ENOSPC|no space left on device|content[- ]length' THEN 'needs_review'
    WHEN failure_reason LIKE '%上游已返回结果%' OR upstream_result_document IS NOT NULL
      OR failure_reason LIKE '%原件尚未保存%' THEN 'result_repair'
    WHEN failure_reason LIKE '%渠道配置已变更%' THEN 'needs_review'
    ELSE 'awaiting_query' END AS kind
  FROM tasks WHERE status='paused' AND paused_kind IS NULL
    AND (attempts > 0 OR upstream_task_id IS NOT NULL OR upstream_submission_started_at IS NOT NULL)
)
UPDATE tasks t SET paused_kind=c.kind,
  repair_error_code=CASE
    WHEN t.failure_reason LIKE '渠道原件已保存到素材库，但图片后处理未完成%' AND t.failure_reason LIKE '%宽高比%' THEN 'IMAGE_RESULT_DIMENSION_MISMATCH'
    WHEN t.failure_reason LIKE '渠道原件已保存到素材库，但图片后处理未完成%' AND t.failure_reason ~ '前景蒙版|全黑|全白' THEN 'RESULT_MASK_INVALID'
    WHEN t.failure_reason LIKE '渠道原件已保存到素材库，但图片后处理未完成%' AND t.failure_reason ~ '格式|尺寸|像素' THEN 'RESULT_OUTPUT_INVALID'
    WHEN c.kind='submission_unknown' THEN 'SUBMISSION_UNKNOWN'
    WHEN c.kind='awaiting_query' THEN 'UPSTREAM_QUERY_PENDING'
    WHEN c.kind='result_repair' AND t.failure_reason ~* 'ENOSPC|no space left on device' THEN 'STORAGE_ENOSPC'
    WHEN c.kind='result_repair' AND t.failure_reason ~* 'content[- ]length' THEN 'STORAGE_LENGTH_MISMATCH'
    WHEN c.kind='result_repair' AND t.failure_reason LIKE '%部分图层%' THEN 'LAYER_PARTIAL_SAVE'
  END,
  next_repair_at=CASE WHEN c.kind IN ('result_repair','awaiting_query') THEN now()+interval '1 minute' END
FROM classified c WHERE c.id=t.id AND t.status='paused' AND t.paused_kind IS NULL;
