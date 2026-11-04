SELECT json_build_object(
  'waitingTasks', (SELECT count(*) FROM tasks WHERE status='waiting'),
  'processingTasks', (SELECT count(*) FROM tasks WHERE status='processing'),
  'submittedWaitingTasks', (SELECT count(*) FROM tasks WHERE status='waiting' AND (upstream_task_id IS NOT NULL OR upstream_submission_started_at IS NOT NULL)),
  'processingChatRequests', (SELECT count(*) FROM usage_chat_requests WHERE status='processing'),
  'processingAnalysisPreviews', (SELECT count(*) FROM usage_analysis_previews WHERE status='processing'),
  'pausedTasks', (SELECT count(*) FROM tasks WHERE status='paused')
);
