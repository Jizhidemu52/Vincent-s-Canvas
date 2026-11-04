-- Additional public catalog coverage for the fixed 048 schema-only operation.
-- Combined with database-state.sql in the same PostgreSQL statement/snapshot.
SELECT jsonb_build_object(
 'sequenceStates',(SELECT coalesce(jsonb_agg(jsonb_build_object(
   'name',sequencename,'lastValue',(xpath('/table/row/last_value/text()',snapshot))[1]::text,
   'isCalled',(xpath('/table/row/is_called/text()',snapshot))[1]::text::boolean) ORDER BY sequencename),'[]'::jsonb)
   FROM (SELECT sequencename,query_to_xml(format('SELECT last_value::text AS last_value,is_called FROM public.%I',sequencename),true,false,'') snapshot
         FROM pg_sequences WHERE schemaname='public') s),
 'functions',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY identity),'[]'::jsonb) FROM
   (SELECT p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' identity,
           pg_get_functiondef(p.oid) definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind IN('f','p')) f),
 'triggers',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY relation,name),'[]'::jsonb) FROM
   (SELECT c.relname relation,t.tgname name,t.tgenabled enabled,pg_get_triggerdef(t.oid) definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal) t)
);
