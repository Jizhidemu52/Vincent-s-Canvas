SELECT json_build_object(
  'longTransactions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start<now()-interval '30 seconds'),
  'waitingLocks',(SELECT count(*) FROM pg_locks WHERE NOT granted),
  'otherCanvasLocks',(SELECT count(*) FROM pg_locks WHERE relation='public.canvas_documents'::regclass AND pid<>pg_backend_pid())
);
