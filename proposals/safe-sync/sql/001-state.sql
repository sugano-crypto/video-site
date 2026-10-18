-- REVIEW CANDIDATE: do not run against production before schema/RLS review.
-- New tables only; existing articles RLS/grants and Storage policy remain untouched.
begin;
create schema if not exists sc_sync_private;
revoke all on schema sc_sync_private from public, anon, authenticated;
create table sc_sync_private.state (
  article_id text primary key,
  master_page_id uuid not null,
  source_database_id uuid not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);
create table sc_sync_private.run_lock (
  singleton boolean primary key default true check (singleton),
  token uuid not null,
  lease_until timestamptz not null
);
alter table sc_sync_private.state enable row level security;
alter table sc_sync_private.run_lock enable row level security;
revoke all on all tables in schema sc_sync_private from public, anon, authenticated;

create function public.sc_sync_state(p_article_id text) returns jsonb
language sql security definer set search_path = '' as $$
  select to_jsonb(s) from sc_sync_private.state s where s.article_id=p_article_id;
$$;
create function public.sc_sync_acquire(p_token uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  insert into sc_sync_private.run_lock(singleton,token,lease_until)
  values(true,p_token,clock_timestamp()+interval '5 minutes')
  on conflict(singleton) do update set token=excluded.token,lease_until=excluded.lease_until
  where sc_sync_private.run_lock.lease_until<clock_timestamp();
  return found;
end;
$$;
create function public.sc_sync_release(p_token uuid) returns void
language sql security definer set search_path = '' as $$
  update sc_sync_private.run_lock set lease_until=clock_timestamp()
  where singleton=true and token=p_token;
$$;
create function public.sc_sync_commit(p_token uuid,p_article jsonb,p_state jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  lock_row sc_sync_private.run_lock;
  state_row sc_sync_private.state;
  candidate public.articles;
begin
  select * into lock_row from sc_sync_private.run_lock where singleton=true for update;
  if not found or lock_row.token<>p_token or lock_row.lease_until<=clock_timestamp() then
    raise exception 'sync_lease_expired';
  end if;
  if p_article->>'article_id' is distinct from p_state->>'article_id'
     or replace(p_state->>'source_database_id','-','')<>'3db36098fd3680e596dcfaa1715d566f' then
    raise exception 'invalid_sync_identity';
  end if;
  select * into state_row from sc_sync_private.state where article_id=p_article->>'article_id';
  if found and (state_row.master_page_id<>(p_state->>'master_page_id')::uuid
    or state_row.source_database_id<>(p_state->>'source_database_id')::uuid) then
    raise exception 'sync_owner_mismatch';
  end if;
  -- Explicit columns: auth, user_profiles, videos and article status are never modified.
  candidate:=jsonb_populate_record(null::public.articles,p_article);
  insert into public.articles(article_id,notion_page_id,title,content_type,published_at,price,body,access_type,
    free_body,target_audience,notion_article_url,note_url,notion_cover_url,notion_audio_url,notion_blocks)
  values(candidate.article_id,candidate.notion_page_id,candidate.title,candidate.content_type,candidate.published_at,
    candidate.price,candidate.body,candidate.access_type,candidate.free_body,candidate.target_audience,
    candidate.notion_article_url,candidate.note_url,candidate.notion_cover_url,candidate.notion_audio_url,candidate.notion_blocks)
  on conflict(article_id) do update set
    notion_page_id=excluded.notion_page_id,title=excluded.title,content_type=excluded.content_type,
    published_at=excluded.published_at,price=excluded.price,body=excluded.body,access_type=excluded.access_type,
    free_body=excluded.free_body,target_audience=excluded.target_audience,notion_article_url=excluded.notion_article_url,
    note_url=excluded.note_url,notion_cover_url=excluded.notion_cover_url,notion_audio_url=excluded.notion_audio_url,
    notion_blocks=excluded.notion_blocks;
  insert into sc_sync_private.state(article_id,master_page_id,source_database_id,fingerprint)
  values(p_state->>'article_id',(p_state->>'master_page_id')::uuid,(p_state->>'source_database_id')::uuid,p_state->>'fingerprint')
  on conflict(article_id) do update set fingerprint=excluded.fingerprint,updated_at=now();
end;
$$;
-- Supabase default function execute grants must be explicitly removed.
revoke all on function public.sc_sync_state(text) from public,anon,authenticated;
revoke all on function public.sc_sync_acquire(uuid) from public,anon,authenticated;
revoke all on function public.sc_sync_release(uuid) from public,anon,authenticated;
revoke all on function public.sc_sync_commit(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.sc_sync_state(text) to service_role;
grant execute on function public.sc_sync_acquire(uuid) to service_role;
grant execute on function public.sc_sync_release(uuid) to service_role;
grant execute on function public.sc_sync_commit(uuid,jsonb,jsonb) to service_role;
commit;
