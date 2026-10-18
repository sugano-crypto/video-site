-- REVIEW TEMPLATE. The guard must only be removed after the staged rollout is approved.
begin;
do $$ begin raise exception 'REVIEW_ONLY: do not apply this template to production yet'; end $$;

-- Prerequisite: a unique Vault secret named sc_sync_cron_secret, matching SYNC_CRON_SECRET.
-- Create it using Vault UI. Do not paste its value into SQL, GitHub or chat.
create function public.sc_request_sync(p_force boolean default false) returns bigint
language plpgsql security definer set search_path = '' as $$
declare secret_value text; request_id bigint; secret_count integer;
begin
  select count(*),max(decrypted_secret) into secret_count,secret_value
  from vault.decrypted_secrets where name='sc_sync_cron_secret';
  if secret_count<>1 or length(secret_value)<32 then raise exception 'sync_secret_missing'; end if;
  select net.http_post(
    url:='https://bicqctaxvponqbzjsjbw.supabase.co/functions/v1/sync-notion-articles-safe',
    headers:=jsonb_build_object('Content-Type','application/json','x-sync-secret',secret_value),
    body:=jsonb_build_object('dry_run',true,'force',p_force),
    timeout_milliseconds:=120000
  ) into request_id;
  -- Initially dry_run=true. Changing this to false requires the separate apply approval.
  return request_id;
end;
$$;
revoke all on function public.sc_request_sync(boolean) from public,anon,authenticated;

-- Retain the existing job name and 03:00 JST schedule; only replace its command.
-- The old unauthenticated function must be retired/secured during the same maintenance.
do $$
declare daily_id bigint; daily_count integer;
begin
  select count(*),min(jobid) into daily_count,daily_id from cron.job where jobname='sync-notion-articles-daily';
  if daily_count<>1 then raise exception 'unexpected_daily_job_count'; end if;
  perform cron.alter_job(daily_id,schedule:='0 18 * * *',command:='select public.sc_request_sync(true);',active:=true);
  if exists(select 1 from cron.job where jobname='sync-notion-articles-fast') then raise exception 'fast_job_already_exists'; end if;
  perform cron.schedule('sync-notion-articles-fast','*/3 * * * *','select public.sc_request_sync(false);');
end;
$$;
commit;
-- cron Succeeded only means the HTTP request was enqueued. Inspect the response status/body,
-- Edge Function logs and report.updated/errors/attention before calling a run successful.
