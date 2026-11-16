-- Additive sync tracking for scheduled and first-run HKJC history ingestion.
-- Existing users and draw/prize rows are left untouched.
create table if not exists public.draw_sync_status (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'PENDING' check (status in ('PENDING','RUNNING','COMPLETED','FAILED')),
  source text,
  draw_count bigint not null default 0 check (draw_count >= 0),
  oldest_date date,
  latest_date date,
  initial_backfill_complete boolean not null default false,
  last_error text,
  synced_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.draw_sync_status enable row level security;
drop policy if exists "own draw sync status" on public.draw_sync_status;
create policy "own draw sync status" on public.draw_sync_status
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update on public.draw_sync_status to authenticated;

comment on table public.draw_sync_status is 'Per-account status and coverage metadata for automated HKJC draw-history synchronization.';
