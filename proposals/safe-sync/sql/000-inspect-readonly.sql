-- Read-only inspection. Does NOT run synchronization or read article bodies/users/secrets.
-- Run separately from the migration/cron candidates and share the single JSON result.
select jsonb_build_object(
  'article_columns',(select jsonb_agg(to_jsonb(c)) from (
    select column_name,data_type,udt_name,is_nullable,column_default
    from information_schema.columns where table_schema='public' and table_name='articles'
    order by ordinal_position
  ) c),
  'article_constraints',(select jsonb_agg(jsonb_build_object('name',con.conname,'definition',pg_get_constraintdef(con.oid)))
    from pg_constraint con join pg_class tab on tab.oid=con.conrelid join pg_namespace ns on ns.oid=tab.relnamespace
    where ns.nspname='public' and tab.relname='articles'),
  'article_rls',(select jsonb_build_object('enabled',c.relrowsecurity,'forced',c.relforcerowsecurity)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='articles'),
  'article_policies',(select jsonb_agg(to_jsonb(p)) from pg_policies p where schemaname='public' and tablename='articles'),
  'article_triggers',(select jsonb_agg(pg_get_triggerdef(t.oid)) from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='articles' and not t.tgisinternal),
  'media_bucket',(select jsonb_build_object('id',id,'public',public,'file_size_limit',file_size_limit,'allowed_mime_types',allowed_mime_types)
    from storage.buckets where id='article-media'),
  'storage_policies',(select jsonb_agg(to_jsonb(p)) from pg_policies p where schemaname='storage' and tablename='objects')
) as sync_review;
