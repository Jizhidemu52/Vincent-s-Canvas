-- Hash only: never export existing draft/custom/published prompt contents.
WITH targets(table_name,key_column,keys) AS (VALUES
 ('module_flags','module_key',ARRAY['creative-virtual-try-on','creative-sketch-to-photo']),
 ('tool_api_configurations','tool_key',ARRAY['creative-virtual-try-on','creative-sketch-to-photo']),
 ('prompt_recipes','key',ARRAY['virtual-try-on','sketch-to-photo']),
 ('prompt_recipe_versions','recipe_key',ARRAY['virtual-try-on','sketch-to-photo'])
), scoped AS (
 SELECT table_name,key,query_to_xml(format(
  'SELECT count(*) AS n,encode(digest(coalesce(string_agg(h,'''' ORDER BY h),''''),''sha256''),''hex'') AS hash FROM (SELECT encode(digest(to_jsonb(t)::text,''sha256''),''hex'') AS h FROM public.%I t WHERE %I=%L) rows',
  table_name,key_column,key),true,false,'') snapshot FROM targets CROSS JOIN LATERAL unnest(keys) key
), other_rows AS (
 SELECT table_name,query_to_xml(format(
  'SELECT count(*) AS n,encode(digest(coalesce(string_agg(h,'''' ORDER BY h),''''),''sha256''),''hex'') AS hash FROM (SELECT encode(digest(to_jsonb(t)::text,''sha256''),''hex'') AS h FROM public.%I t WHERE NOT (%I=ANY(%L::text[]))) rows',
  table_name,key_column,keys),true,false,'') snapshot FROM targets
)
SELECT jsonb_build_object(
 'creativeScopes',(SELECT jsonb_agg(jsonb_build_object('table',table_name,'key',key,
  'count',(xpath('/table/row/n/text()',snapshot))[1]::text::bigint,
  'sha256',(xpath('/table/row/hash/text()',snapshot))[1]::text) ORDER BY table_name,key) FROM scoped),
 'creativeOtherRows',(SELECT jsonb_agg(jsonb_build_object('name',table_name,
  'count',(xpath('/table/row/n/text()',snapshot))[1]::text::bigint,
  'sha256',(xpath('/table/row/hash/text()',snapshot))[1]::text) ORDER BY table_name) FROM other_rows)
);
