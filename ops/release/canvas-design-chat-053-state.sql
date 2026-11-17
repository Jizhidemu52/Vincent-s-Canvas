WITH targets(table_name,key_column) AS (VALUES
 ('module_flags','module_key'),('tool_api_configurations','tool_key')
), old_rows AS (
 SELECT table_name,query_to_xml(format(
  'SELECT count(*) AS n,encode(digest(coalesce(string_agg(h,'''' ORDER BY h),''''),''sha256''),''hex'') AS hash FROM (SELECT encode(digest(to_jsonb(t)::text,''sha256''),''hex'') AS h FROM public.%I t WHERE %I<>''canvas-design-chat'') rows',
  table_name,key_column),true,false,'') snapshot FROM targets
)
SELECT jsonb_build_object(
 'designChatOtherRows',(SELECT jsonb_agg(jsonb_build_object('name',table_name,
   'count',(xpath('/table/row/n/text()',snapshot))[1]::text::bigint,
   'sha256',(xpath('/table/row/hash/text()',snapshot))[1]::text) ORDER BY table_name) FROM old_rows),
 'designChatSeeds',jsonb_build_object(
   'module_flags',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM public.module_flags t WHERE module_key='canvas-design-chat'),
   'tool_api_configurations',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM public.tool_api_configurations t WHERE tool_key='canvas-design-chat')),
 'designChatModel',(SELECT coalesce(jsonb_agg(jsonb_build_object(
   'id',m.id,'providerId',m.provider_id,'modelId',m.model_id,'protocol',p.protocol,
   'modelEnabled',m.enabled,'providerEnabled',p.enabled,'hasCredentials',p.encrypted_credentials IS NOT NULL,
   'workflowConfigId',m.workflow_config_id,'capabilities',m.capabilities) ORDER BY m.id),'[]'::jsonb)
   FROM public.model_configs m JOIN public.providers p ON p.id=m.provider_id
   WHERE m.provider_id='9567f5da-bb4d-4e4b-b680-c7184d00a001'::uuid AND m.model_id='gemini-4-carbon'),
 'designChatSafety',jsonb_build_object(
   'enabledEventTriggers',(SELECT count(*) FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D'),
   'seedTableTriggers',(SELECT count(*) FROM pg_catalog.pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('public.module_flags'::regclass,'public.tool_api_configurations'::regclass,'public.schema_migrations'::regclass)),
   'seedTableRules',(SELECT count(*) FROM pg_catalog.pg_rewrite WHERE ev_class IN ('public.module_flags'::regclass,'public.tool_api_configurations'::regclass,'public.schema_migrations'::regclass)),
   'seedTableRls',(SELECT count(*) FROM pg_catalog.pg_class WHERE oid IN ('public.module_flags'::regclass,'public.tool_api_configurations'::regclass,'public.schema_migrations'::regclass) AND (relrowsecurity OR relforcerowsecurity)))
);
