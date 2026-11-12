-- Only hashes of existing rows leave PostgreSQL. The two new output columns
-- are excluded from the task hash on BOTH sides, then checked NULL separately.
WITH targets(table_name,key_column) AS (VALUES
 ('module_flags','module_key'),('tool_api_configurations','tool_key')
), old_rows AS (
 SELECT table_name,query_to_xml(format(
  'SELECT count(*) AS n,encode(digest(coalesce(string_agg(h,'''' ORDER BY h),''''),''sha256''),''hex'') AS hash FROM (SELECT encode(digest(to_jsonb(t)::text,''sha256''),''hex'') AS h FROM public.%I t WHERE %I<>''layer-studio'') rows',
  table_name,key_column),true,false,'') snapshot FROM targets
), task_rows AS (
 SELECT count(*) n,encode(digest(coalesce(string_agg(h,'' ORDER BY h),''),'sha256'),'hex') hash
 FROM (SELECT encode(digest((to_jsonb(t)-ARRAY['result_document','upstream_result_document'])::text,'sha256'),'hex') h FROM public.tasks t) rows
)
SELECT jsonb_build_object(
 'layerStudioTaskLayout',(SELECT jsonb_build_object('relnatts',c.relnatts,'attributes',
   (SELECT coalesce(jsonb_agg(jsonb_build_object('attnum',a.attnum,'attname',a.attname,'attisdropped',a.attisdropped) ORDER BY a.attnum),'[]'::jsonb)
    FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0))
   FROM pg_catalog.pg_class c WHERE c.oid='public.tasks'::regclass),
 'layerStudioOriginalTasks',(SELECT jsonb_build_object('name','tasks','count',n,'sha256',hash) FROM task_rows),
 'layerStudioNonNullOutputs',(SELECT count(*) FROM public.tasks t
   WHERE coalesce(to_jsonb(t)->'result_document','null'::jsonb)<>'null'::jsonb
      OR coalesce(to_jsonb(t)->'upstream_result_document','null'::jsonb)<>'null'::jsonb),
 'layerStudioOtherRows',(SELECT jsonb_agg(jsonb_build_object('name',table_name,
   'count',(xpath('/table/row/n/text()',snapshot))[1]::text::bigint,
   'sha256',(xpath('/table/row/hash/text()',snapshot))[1]::text) ORDER BY table_name) FROM old_rows),
 'layerStudioSeeds',jsonb_build_object(
   'module_flags',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM public.module_flags t WHERE module_key='layer-studio'),
   'tool_api_configurations',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM public.tool_api_configurations t WHERE tool_key='layer-studio')),
 'layerStudioSafety',jsonb_build_object(
   'enabledEventTriggers',(SELECT count(*) FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D'),
   'seedTableTriggers',(SELECT count(*) FROM pg_catalog.pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('public.module_flags'::regclass,'public.tool_api_configurations'::regclass,'public.schema_migrations'::regclass)),
   'seedTableRules',(SELECT count(*) FROM pg_catalog.pg_rewrite WHERE ev_class IN ('public.module_flags'::regclass,'public.tool_api_configurations'::regclass,'public.schema_migrations'::regclass)),
   'seedTableRls',(SELECT count(*) FROM pg_catalog.pg_class WHERE oid IN ('public.module_flags'::regclass,'public.tool_api_configurations'::regclass,'public.schema_migrations'::regclass) AND (relrowsecurity OR relforcerowsecurity)))
);
