-- Quantitative Engine v2 additive migration. Existing accounts and rows are kept.
-- Apply after the original supabase/schema.sql bootstrap.
alter table public.draws add column if not exists lifecycle_state text not null default 'NUMBERS_ONLY';
alter table public.draws alter column lifecycle_state set default 'NUMBERS_ONLY';
update public.draws set lifecycle_state = 'NUMBERS_ONLY' where lifecycle_state is null;
alter table public.draws alter column lifecycle_state set not null;
alter table public.draws alter column draw_date drop not null;
alter table public.draws alter column n1 drop not null;
alter table public.draws alter column n2 drop not null;
alter table public.draws alter column n3 drop not null;
alter table public.draws alter column n4 drop not null;
alter table public.draws alter column n5 drop not null;
alter table public.draws alter column n6 drop not null;
alter table public.draws drop constraint if exists draws_lifecycle_state_check;
alter table public.draws add constraint draws_lifecycle_state_check
  check (lifecycle_state in ('PRE_DRAW','NUMBERS_ONLY','PRIZE_DATA_READY','MODEL_UPDATED'));
alter table public.draws drop constraint if exists draws_lifecycle_numbers_date_check;
alter table public.draws add constraint draws_lifecycle_numbers_date_check check (
  ((lifecycle_state = 'PRE_DRAW' and n1 is null and n2 is null and n3 is null and n4 is null and n5 is null and n6 is null)
   or (lifecycle_state <> 'PRE_DRAW' and draw_date is not null and n1 is not null and n2 is not null and n3 is not null and n4 is not null and n5 is not null and n6 is not null))
);

create table if not exists public.draw_market_data (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  draw_id text not null,
  lifecycle_state text not null default 'PRE_DRAW'
    check (lifecycle_state in ('PRE_DRAW','NUMBERS_ONLY','PRIZE_DATA_READY','MODEL_UPDATED')),
  estimated_jackpot numeric(14,2),
  estimated_sales numeric(14,2),
  estimated_ticket_cost numeric(14,2),
  actual_sales numeric(14,2),
  official_jackpot numeric(14,2),
  snowball_amount numeric(14,2),
  snowball_code text,
  snowball_name text,
  unit_bet numeric(12,2),
  pool_status text,
  pool_sell boolean,
  estimated_prize numeric(14,2),
  first_prize_dividend numeric(14,2),
  second_prize_dividend numeric(14,2),
  third_prize_dividend numeric(14,2),
  first_prize_winning_units numeric(14,2),
  second_prize_winning_units numeric(14,2),
  third_prize_winning_units numeric(14,2),
  estimated_first_prize_dividend numeric(14,2),
  prize_data jsonb,
  field_sources jsonb not null default '{}'::jsonb,
  data_version bigint not null default 1,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, draw_id),
  check (estimated_jackpot is null or estimated_jackpot >= 0),
  check (estimated_sales is null or estimated_sales >= 0),
  check (estimated_ticket_cost is null or estimated_ticket_cost > 0),
  check (actual_sales is null or actual_sales >= 0),
  check (official_jackpot is null or official_jackpot >= 0),
  check (unit_bet is null or unit_bet > 0),
  check (estimated_prize is null or estimated_prize >= 0),
  check (prize_data is null or jsonb_typeof(prize_data) = 'array')
);
alter table public.draw_market_data add column if not exists estimated_jackpot numeric(14,2);
alter table public.draw_market_data add column if not exists estimated_sales numeric(14,2);
alter table public.draw_market_data add column if not exists estimated_ticket_cost numeric(14,2);
alter table public.draw_market_data add column if not exists actual_sales numeric(14,2);
alter table public.draw_market_data add column if not exists official_jackpot numeric(14,2);
alter table public.draw_market_data add column if not exists snowball_code text;
alter table public.draw_market_data add column if not exists snowball_name text;
alter table public.draw_market_data add column if not exists snowball_amount numeric(14,2);
alter table public.draw_market_data add column if not exists unit_bet numeric(12,2);
alter table public.draw_market_data add column if not exists pool_status text;
alter table public.draw_market_data add column if not exists pool_sell boolean;
alter table public.draw_market_data add column if not exists estimated_prize numeric(14,2);
alter table public.draw_market_data add column if not exists first_prize_dividend numeric(14,2);
alter table public.draw_market_data add column if not exists prize_data jsonb;
alter table public.draw_market_data add column if not exists field_sources jsonb not null default '{}'::jsonb;
alter table public.draw_market_data add column if not exists data_version bigint not null default 1;
alter table public.draw_market_data add column if not exists last_error text;
alter table public.draw_market_data add column if not exists created_at timestamptz not null default now();
alter table public.draw_market_data add column if not exists updated_at timestamptz not null default now();
alter table public.draw_market_data add column if not exists estimated_first_prize_dividend numeric(14,2);
alter table public.draw_market_data add column if not exists second_prize_dividend numeric(14,2);
alter table public.draw_market_data add column if not exists third_prize_dividend numeric(14,2);
alter table public.draw_market_data add column if not exists first_prize_winning_units numeric(14,2);
alter table public.draw_market_data add column if not exists second_prize_winning_units numeric(14,2);
alter table public.draw_market_data add column if not exists third_prize_winning_units numeric(14,2);
alter table public.draw_market_data drop constraint if exists draw_market_nonnegative_estimates;
alter table public.draw_market_data add constraint draw_market_nonnegative_estimates check (
  (estimated_jackpot is null or estimated_jackpot >= 0) and
  (estimated_sales is null or estimated_sales >= 0) and
  (actual_sales is null or actual_sales >= 0) and
  (official_jackpot is null or official_jackpot >= 0) and
  (snowball_amount is null or snowball_amount >= 0) and
  (unit_bet is null or unit_bet > 0) and
  (estimated_prize is null or estimated_prize >= 0) and
  (estimated_ticket_cost is null or estimated_ticket_cost > 0)
);
alter table public.draw_market_data drop constraint if exists draw_market_prize_data_array_check;
alter table public.draw_market_data add constraint draw_market_prize_data_array_check
  check (prize_data is null or jsonb_typeof(prize_data) = 'array');

create table if not exists public.engine_feature_snapshots (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  feature_key text not null,
  through_draw_id text,
  data_version bigint not null,
  model_version text not null,
  features jsonb not null,
  calculated_at timestamptz not null default now(),
  unique (user_id, feature_key, data_version, model_version)
);

create table if not exists public.engine_runs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  run_mode text not null check (run_mode in ('INCREMENTAL','FULL_RECALCULATION','PRE_DRAW')),
  trigger_reason text not null,
  draw_id text,
  model_version text not null,
  data_version bigint not null,
  status text not null default 'PENDING' check (status in ('PENDING','RUNNING','COMPLETED','FAILED')),
  result_summary jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.engine_data_versions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  current_version bigint not null default 0,
  draw_version bigint not null default 0,
  market_version bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.engine_data_versions add column if not exists draw_version bigint not null default 0;
alter table public.engine_data_versions add column if not exists market_version bigint not null default 0;
insert into public.engine_data_versions(user_id, current_version, draw_version, market_version)
select user_id, count(*) filter (where lifecycle_state <> 'PRE_DRAW'), count(*) filter (where lifecycle_state <> 'PRE_DRAW'), 0
from public.draws group by user_id
on conflict (user_id) do nothing;
update public.engine_data_versions v
set draw_version = h.history_count,
    current_version = greatest(v.current_version, h.history_count),
    updated_at = now()
from (
  select user_id, count(*) filter (where lifecycle_state <> 'PRE_DRAW') as history_count
  from public.draws group by user_id
) h
where v.user_id = h.user_id and v.draw_version = 0 and h.history_count > 0;

create or replace function public.bump_engine_data_version()
returns trigger language plpgsql security definer set search_path = '' as $$
declare target_user uuid;
begin
  target_user := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  if not exists (select 1 from auth.users where id = target_user) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  insert into public.engine_data_versions(user_id, current_version, updated_at)
  values (target_user, 1, now())
  on conflict (user_id) do update
    set current_version = public.engine_data_versions.current_version + 1,
        draw_version = public.engine_data_versions.draw_version + 1, updated_at = now();
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists draws_bump_engine_data_version on public.draws;
drop trigger if exists draws_bump_engine_data_version_insert on public.draws;
drop trigger if exists draws_bump_engine_data_version_update on public.draws;
drop trigger if exists draws_bump_engine_data_version_delete on public.draws;
create trigger draws_bump_engine_data_version_insert after insert on public.draws
  for each row when (new.lifecycle_state <> 'PRE_DRAW') execute function public.bump_engine_data_version();
create trigger draws_bump_engine_data_version_update after update on public.draws
  for each row when ((new.lifecycle_state <> 'PRE_DRAW' or old.lifecycle_state <> 'PRE_DRAW') and (old.user_id, old.draw_id, old.draw_date, old.n1, old.n2, old.n3, old.n4, old.n5, old.n6, old.extra)
    is distinct from (new.user_id, new.draw_id, new.draw_date, new.n1, new.n2, new.n3, new.n4, new.n5, new.n6, new.extra))
  execute function public.bump_engine_data_version();
create trigger draws_bump_engine_data_version_delete after delete on public.draws
  for each row when (old.lifecycle_state <> 'PRE_DRAW') execute function public.bump_engine_data_version();

create or replace function public.bump_engine_market_version()
returns trigger language plpgsql security definer set search_path = '' as $$
declare target_user uuid;
begin
  target_user := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  if not exists (select 1 from auth.users where id = target_user) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  insert into public.engine_data_versions(user_id, current_version, market_version, updated_at)
  values (target_user, 1, 1, now())
  on conflict (user_id) do update
    set current_version = public.engine_data_versions.current_version + 1,
        market_version = public.engine_data_versions.market_version + 1, updated_at = now();
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists draw_market_bump_engine_market_version_insert on public.draw_market_data;
drop trigger if exists draw_market_bump_engine_market_version_update on public.draw_market_data;
drop trigger if exists draw_market_bump_engine_market_version_delete on public.draw_market_data;
create trigger draw_market_bump_engine_market_version_insert after insert on public.draw_market_data
  for each row execute function public.bump_engine_market_version();
create trigger draw_market_bump_engine_market_version_update after update on public.draw_market_data
  for each row when (old is distinct from new) execute function public.bump_engine_market_version();
create trigger draw_market_bump_engine_market_version_delete after delete on public.draw_market_data
  for each row execute function public.bump_engine_market_version();

create index if not exists draw_market_user_state_idx on public.draw_market_data(user_id, lifecycle_state);
create index if not exists engine_runs_user_created_idx on public.engine_runs(user_id, created_at desc);
create index if not exists engine_features_latest_idx on public.engine_feature_snapshots(user_id, feature_key, calculated_at desc);

alter table public.draw_market_data enable row level security;
alter table public.engine_feature_snapshots enable row level security;
alter table public.engine_runs enable row level security;
alter table public.engine_data_versions enable row level security;

drop policy if exists "own draw market data" on public.draw_market_data;
create policy "own draw market data" on public.draw_market_data
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own engine feature snapshots" on public.engine_feature_snapshots;
create policy "own engine feature snapshots" on public.engine_feature_snapshots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own engine runs" on public.engine_runs;
create policy "own engine runs" on public.engine_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own engine data versions" on public.engine_data_versions;
create policy "own engine data versions" on public.engine_data_versions
  for select using (auth.uid() = user_id);

grant select, insert, update, delete on public.draw_market_data, public.engine_feature_snapshots, public.engine_runs to authenticated;
grant select on public.engine_data_versions to authenticated;
grant usage, select on sequence public.draw_market_data_id_seq, public.engine_feature_snapshots_id_seq, public.engine_runs_id_seq to authenticated;

comment on column public.draw_market_data.prize_data is 'Official per-division dividend and winning-unit records; JSON null means unpublished/unknown, never zero.';
comment on column public.draw_market_data.field_sources is 'Per-field provenance and observed_at metadata; distinguish estimates from official values.';
