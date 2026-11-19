WITH old_models AS (
 SELECT count(*) AS count,encode(digest(coalesce(string_agg(h,'' ORDER BY h),''),'sha256'),'hex') AS sha256
 FROM (
  SELECT encode(digest(to_jsonb(m)::text,'sha256'),'hex') AS h FROM public.model_configs m
  WHERE NOT (provider_id='9567f5da-bb4d-4e4b-b680-c7184d00a001'::uuid AND model_id='mai-image-2.7-flash')
 ) rows
)
SELECT jsonb_build_object(
 'mai27OtherModels',(SELECT jsonb_build_object('name','model_configs','count',count,'sha256',sha256) FROM old_models),
 'mai27Source',(SELECT coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object('rmb_cost',m.rmb_cost::text) ORDER BY id),'[]'::jsonb) FROM public.model_configs m
   WHERE provider_id='9567f5da-bb4d-4e4b-b680-c7184d00a001'::uuid AND model_id='mai-image-2.6-flash'),
 'mai27Target',(SELECT coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object('rmb_cost',m.rmb_cost::text) ORDER BY id),'[]'::jsonb) FROM public.model_configs m
   WHERE provider_id='9567f5da-bb4d-4e4b-b680-c7184d00a001'::uuid AND model_id='mai-image-2.7-flash'),
 'mai27Provider',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'protocol',protocol) ORDER BY id),'[]'::jsonb)
   FROM public.providers WHERE id='9567f5da-bb4d-4e4b-b680-c7184d00a001'::uuid),
 'mai27MaximumPublicNumber',(SELECT coalesce(max(public_number),0) FROM public.model_configs),
 'mai27Safety',jsonb_build_object(
   'enabledEventTriggers',(SELECT count(*) FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D'),
   'seedTableTriggers',(SELECT count(*) FROM pg_catalog.pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('public.model_configs'::regclass,'public.schema_migrations'::regclass)),
   'seedTableRules',(SELECT count(*) FROM pg_catalog.pg_rewrite WHERE ev_class IN ('public.model_configs'::regclass,'public.schema_migrations'::regclass)),
   'seedTableRls',(SELECT count(*) FROM pg_catalog.pg_class WHERE oid IN ('public.model_configs'::regclass,'public.schema_migrations'::regclass) AND (relrowsecurity OR relforcerowsecurity)))
);
