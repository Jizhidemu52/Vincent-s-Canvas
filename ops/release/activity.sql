WITH conversation_relation AS (
  SELECT to_regclass('public.image_conversation_turns') IS NOT NULL AS present,
    EXISTS (SELECT 1 FROM schema_migrations WHERE name='054_image_conversations.sql') AS registered
), conversation_activity AS MATERIALIZED (
  SELECT present, CASE WHEN present OR registered THEN query_to_xml($conversation_activity$
    SELECT count(*) FILTER (WHERE state IN ('accepted','planning','queued','generating')) AS active_turns,
      count(*) FILTER (WHERE planner_lease_token IS NOT NULL OR planner_lease_expires_at IS NOT NULL) AS planner_leases,
      count(*) FILTER (WHERE planner_status='in_flight') AS in_flight_planners,
      count(*) FILTER (WHERE state='uncertain' OR planner_status='unknown') AS uncertain_turns
    FROM public.image_conversation_turns
  $conversation_activity$,true,false,'') ELSE NULL END AS snapshot
  FROM conversation_relation
)
SELECT json_build_object(
  'waitingTasks', (SELECT count(*) FROM tasks WHERE status='waiting'),
  'processingTasks', (SELECT count(*) FROM tasks WHERE status='processing'),
  'submittedWaitingTasks', (SELECT count(*) FROM tasks WHERE status='waiting' AND (upstream_task_id IS NOT NULL OR upstream_submission_started_at IS NOT NULL)),
  'processingChatRequests', (SELECT count(*) FROM usage_chat_requests WHERE status='processing'),
  'processingAnalysisPreviews', (SELECT count(*) FROM usage_analysis_previews WHERE status='processing'),
  'pausedTasks', (SELECT count(*) FROM tasks WHERE status='paused'),
  'pendingAssetThumbnails', (SELECT count(*) FROM assets
    WHERE kind IN ('image','video') AND status='ready' AND deleted_at IS NULL
      AND (((thumbnail_256_key IS NULL OR thumbnail_1024_key IS NULL) AND thumbnail_attempts < 4)
        OR thumbnail_lease_token IS NOT NULL)),
  'imageConversationTurnsPresent', present,
  'activeTurns', CASE WHEN snapshot IS NULL THEN 0 ELSE (xpath('/table/row/active_turns/text()',snapshot))[1]::text::bigint END,
  'plannerLeases', CASE WHEN snapshot IS NULL THEN 0 ELSE (xpath('/table/row/planner_leases/text()',snapshot))[1]::text::bigint END,
  'inFlightPlanners', CASE WHEN snapshot IS NULL THEN 0 ELSE (xpath('/table/row/in_flight_planners/text()',snapshot))[1]::text::bigint END,
  'uncertainTurns', CASE WHEN snapshot IS NULL THEN 0 ELSE (xpath('/table/row/uncertain_turns/text()',snapshot))[1]::text::bigint END
) FROM conversation_activity;
