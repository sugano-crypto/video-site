-- REVIEW CANDIDATE ONLY. Stage before use. Does NOT change the Storage bucket's public flag.
-- Requires auth.uid(), auth.role(), auth.users and public.user_profiles (Supabase).
begin;
create function public.sc_member_is_admin() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.users u where u.id=auth.uid() and lower(u.email)='sugano@sugacon.net');
$$;
create function public.sc_can_list_article(a public.articles) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and (
   public.sc_member_is_admin() or (
     coalesce(lower(trim(a.status)),'') in ('','published','公開','公開中')
     and exists(select 1 from public.user_profiles p
       where to_jsonb(p)->>'id'=auth.uid()::text
       and coalesce(to_jsonb(p)->>'contract_status','未契約')<>'契約終了'
       and (
         (to_jsonb(p)->>'user_type'='医師' and coalesce(lower(trim(a.target_audience)),'all') in ('','doctor','doctors','医師','医師向け','all','both','共通','全員'))
         or (to_jsonb(p)->>'user_type'='事務' and coalesce(lower(trim(a.target_audience)),'all') in ('','staff','office','admin','事務','事務向け','all','both','共通','全員'))
       )
     )
   )
 );
$$;
create function public.sc_can_read_article(a public.articles) returns boolean
language sql stable security definer set search_path='' as $$
 select public.sc_member_is_admin() or (
   public.sc_can_list_article(a) and exists(select 1 from public.user_profiles p
     where to_jsonb(p)->>'id'=auth.uid()::text and to_jsonb(p)->>'contract_status'='契約中')
 );
$$;
create function public.sc_member_articles() returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object(
   'id',a.id,'title',a.title,'content_type',a.content_type,'published_at',a.published_at,'status',a.status,
   'price',a.price,'access_type',a.access_type,'target_audience',a.target_audience,
   'free_body',a.free_body,'note_url',a.note_url,
   'body',case when public.sc_can_read_article(a) then a.body end,
   'notion_blocks',case when public.sc_can_read_article(a) then a.notion_blocks end,
   'notion_article_url',case when public.sc_can_read_article(a) then a.notion_article_url end,
   'notion_cover_url',case when public.sc_can_read_article(a) then a.notion_cover_url end,
   'notion_audio_url',case when public.sc_can_read_article(a) then a.notion_audio_url end
 ) order by a.published_at desc nulls last,a.id desc),'[]'::jsonb)
 from public.articles a where public.sc_can_list_article(a);
$$;
create function public.sc_member_article(p_id bigint) returns jsonb
language sql stable security definer set search_path='' as $$
 select to_jsonb(a) from public.articles a where a.id=p_id and public.sc_can_read_article(a);
$$;
-- The broad production SELECT policy must not coexist with the replacement.
do $$ begin
 if exists(select 1 from pg_policies where schemaname='public' and tablename='articles'
   and cmd in ('SELECT','ALL') and policyname<>'Authenticated users can read articles') then
   raise exception 'unexpected_article_policy_review_required';
 end if;
end $$;
drop policy if exists "Authenticated users can read articles" on public.articles;
create policy sc_entitled_article_read on public.articles for select to authenticated
 using(public.sc_can_read_article(articles.*));

-- Prevent self-upgrade even if an old profile UPDATE policy permits all own columns.
-- Existing RLS still applies; this trigger adds restrictions and grants no new access.
create function public.sc_guard_member_profile() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if auth.role()='service_role' or public.sc_member_is_admin()
    or (auth.uid() is null and session_user='postgres') then
   if tg_op='DELETE' then return old; else return new; end if;
 end if;
 if tg_op<>'UPDATE' or auth.uid() is null then raise exception 'profile_admin_required'; end if;
 if to_jsonb(old)->>'id' is distinct from auth.uid()::text
   or (to_jsonb(new)-'is_first_login'-'updated_at') is distinct from (to_jsonb(old)-'is_first_login'-'updated_at')
   or to_jsonb(new)->>'is_first_login' is distinct from 'false' then
   raise exception 'profile_protected_columns';
 end if;
 return new;
end;
$$;
create trigger sc_guard_member_profile before insert or update or delete on public.user_profiles
 for each row execute function public.sc_guard_member_profile();

create function public.sc_sync_access_ready() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from storage.buckets where id='article-media' and public=false)
 and exists(select 1 from pg_policies where schemaname='public' and tablename='articles' and policyname='sc_entitled_article_read')
 and exists(select 1 from pg_trigger t where t.tgrelid='public.user_profiles'::regclass and t.tgname='sc_guard_member_profile');
$$;
revoke all on function public.sc_member_is_admin() from public,anon,authenticated;
revoke all on function public.sc_can_list_article(public.articles) from public,anon,authenticated;
revoke all on function public.sc_can_read_article(public.articles) from public,anon,authenticated;
revoke all on function public.sc_member_article(bigint) from public,anon,authenticated;
revoke all on function public.sc_member_articles() from public,anon,authenticated;
revoke all on function public.sc_guard_member_profile() from public,anon,authenticated;
revoke all on function public.sc_sync_access_ready() from public,anon,authenticated;
grant execute on function public.sc_member_is_admin() to authenticated;
grant execute on function public.sc_can_list_article(public.articles) to authenticated;
grant execute on function public.sc_can_read_article(public.articles) to authenticated;
grant execute on function public.sc_member_article(bigint) to authenticated;
grant execute on function public.sc_member_articles() to authenticated;
grant execute on function public.sc_sync_access_ready() to service_role;
commit;
