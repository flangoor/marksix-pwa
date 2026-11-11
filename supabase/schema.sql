-- Run in Supabase SQL Editor. Each user's data is isolated by RLS.
create table if not exists public.draws (
 id bigint generated always as identity primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 draw_id text not null,
 draw_date date not null,
 n1 int not null check(n1 between 1 and 49),
 n2 int not null check(n2 between 1 and 49),
 n3 int not null check(n3 between 1 and 49),
 n4 int not null check(n4 between 1 and 49),
 n5 int not null check(n5 between 1 and 49),
 n6 int not null check(n6 between 1 and 49),
 extra int check(extra between 1 and 49),
 source text default 'CSV',
 created_at timestamptz default now(),
 unique(user_id,draw_id),
 check(n1<>n2 and n1<>n3 and n1<>n4 and n1<>n5 and n1<>n6 and n2<>n3 and n2<>n4 and n2<>n5 and n2<>n6 and n3<>n4 and n3<>n5 and n3<>n6 and n4<>n5 and n4<>n6 and n5<>n6)
);
create index if not exists draws_user_date_idx on public.draws(user_id,draw_date);
create table if not exists public.recommendations (
 id bigint generated always as identity primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 as_of_draw text,
 combinations jsonb not null,
 model_version text not null default 'weighted-v1',
 created_at timestamptz default now()
);
alter table public.draws enable row level security;
alter table public.recommendations enable row level security;
create policy "own draws select" on public.draws for select using(auth.uid()=user_id);
create policy "own draws insert" on public.draws for insert with check(auth.uid()=user_id);
create policy "own draws update" on public.draws for update using(auth.uid()=user_id) with check(auth.uid()=user_id);
create policy "own draws delete" on public.draws for delete using(auth.uid()=user_id);
create policy "own recommendations select" on public.recommendations for select using(auth.uid()=user_id);
create policy "own recommendations insert" on public.recommendations for insert with check(auth.uid()=user_id);
create policy "own recommendations delete" on public.recommendations for delete using(auth.uid()=user_id);
