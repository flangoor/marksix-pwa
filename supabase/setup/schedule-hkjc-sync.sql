-- Run only after adding these three entries to Supabase Vault:
--   marksix_project_url       e.g. https://<project-ref>.supabase.co
--   marksix_anon_key          the project's publishable/anon key
--   marksix_sync_cron_secret  same random secret as Edge Function SYNC_CRON_SECRET
-- The service-role key is never copied into Vault, GitHub, or the browser.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'marksix_project_url')
     or not exists (select 1 from vault.decrypted_secrets where name = 'marksix_anon_key')
     or not exists (select 1 from vault.decrypted_secrets where name = 'marksix_sync_cron_secret') then
    raise exception 'Add the three marksix_* values to Supabase Vault before scheduling the sync';
  end if;
end;
$$;

select cron.unschedule(jobid)
from cron.job
where jobname = 'marksix-hkjc-history-sync';

select cron.schedule(
  'marksix-hkjc-history-sync',
  '17 */6 * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'marksix_project_url') || '/functions/v1/sync-hkjc',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'marksix_anon_key'),
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'marksix_sync_cron_secret'),
        'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'marksix_sync_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 145000
    ) as request_id;
  $$
);

-- Verification: exactly one active job should be returned after setup.
select jobid, jobname, schedule, active
from cron.job
where jobname = 'marksix-hkjc-history-sync';

-- Cron success means the HTTP request was queued. After the first run, also
-- confirm pg_net got HTTP 200 and the per-account sync status was updated.
select jobid, status, start_time, end_time, return_message
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'marksix-hkjc-history-sync')
order by start_time desc
limit 5;

select id, status_code, timed_out, error_msg, created
from net._http_response
order by created desc
limit 5;

select status, initial_backfill_complete, draw_count, oldest_date, latest_date, synced_at, last_error
from public.draw_sync_status
order by synced_at desc nulls last
limit 5;
