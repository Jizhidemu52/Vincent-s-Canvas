-- One repeatable-read snapshot. Only identities, schema and hashes leave PostgreSQL.
-- No row values, prompts, credentials, or private recipes are exported here.
SELECT jsonb_build_object(
 'identity',jsonb_build_object('database',current_database(),'schema',current_schema(),'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system())),
 'migrations',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY name),'[]'::jsonb) FROM schema_migrations m),
 'columns',(SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,ordinal_position) FROM (SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default,numeric_precision,numeric_scale FROM information_schema.columns WHERE table_schema='public') c),
 'indexes',(SELECT jsonb_agg(to_jsonb(i) ORDER BY tablename,indexname) FROM (SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public') i),
 'constraints',(SELECT jsonb_agg(to_jsonb(c) ORDER BY relation,name) FROM (SELECT cl.relname relation,co.conname name,co.contype type,pg_get_constraintdef(co.oid) definition FROM pg_constraint co JOIN pg_class cl ON cl.oid=co.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='public') c),
 'sequences',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY sequencename),'[]'::jsonb) FROM (SELECT sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value FROM pg_sequences WHERE schemaname='public') s),
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',tablename,'count',(xpath('/table/row/n/text()',snapshot))[1]::text::bigint,'sha256',(xpath('/table/row/hash/text()',snapshot))[1]::text) ORDER BY tablename)
   FROM (SELECT tablename,query_to_xml(format('SELECT count(*) AS n,encode(digest(coalesce(string_agg(h,'''' ORDER BY h),''''),''sha256''),''hex'') AS hash FROM (SELECT encode(digest(to_jsonb(t)::text,''sha256''),''hex'') AS h FROM public.%I t) rows',tablename),true,false,'') snapshot FROM pg_tables WHERE schemaname='public') hashes)
);
