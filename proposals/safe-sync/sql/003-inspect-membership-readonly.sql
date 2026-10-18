-- Read-only metadata/aggregates only. No user records, article bodies or secrets.
select '会員列と記事ID採番' as section, to_jsonb(c) as detail
from (
 select table_name,column_name,data_type,udt_name,is_nullable,column_default,is_identity,identity_generation
 from information_schema.columns
 where table_schema='public'
   and (table_name='user_profiles' or (table_name='articles' and column_name='id'))
 order by table_name,ordinal_position
) c
union all
select '会員ポリシー',to_jsonb(p)
from pg_policies p where schemaname='public' and tablename='user_profiles'
union all
select '会員RLS',jsonb_build_object('enabled',t.relrowsecurity,'forced',t.relforcerowsecurity)
from pg_class t join pg_namespace n on n.oid=t.relnamespace
where n.nspname='public' and t.relname='user_profiles'
union all
select '会員テーブル権限',jsonb_build_object(
 'role',r.role_name,'select',has_table_privilege(r.role_name,'public.user_profiles','SELECT'),
 'insert',has_table_privilege(r.role_name,'public.user_profiles','INSERT'),
 'update',has_table_privilege(r.role_name,'public.user_profiles','UPDATE'),
 'delete',has_table_privilege(r.role_name,'public.user_profiles','DELETE'))
from (values ('anon'),('authenticated')) r(role_name)
union all
select '会員列更新権限',jsonb_build_object('column',column_name,
 'authenticated_update',has_column_privilege('authenticated','public.user_profiles',column_name,'UPDATE'))
from information_schema.columns
where table_schema='public' and table_name='user_profiles'
union all
select '会員トリガー',jsonb_build_object('definition',pg_get_triggerdef(tr.oid))
from pg_trigger tr join pg_class t on t.oid=tr.tgrelid join pg_namespace n on n.oid=t.relnamespace
where n.nspname='public' and t.relname='user_profiles' and not tr.tgisinternal
union all
select '記事公開区分の集計',to_jsonb(a)
from (
 select status,access_type,target_audience,count(*) as count
 from public.articles group by status,access_type,target_audience
) a;
