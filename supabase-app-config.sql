-- Run this once in the Supabase SQL editor (Dashboard > SQL Editor > New query > Run).
-- It creates a single shared-settings row so the catalog URL, Claude API key, model,
-- and token prices are shared across every signed-in device instead of per-browser.

create table if not exists public.app_config (
  id text primary key default 'default',
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_config enable row level security;

-- Only signed-in users can read or write the shared config. This keeps the stored
-- Claude API key out of reach of anonymous visitors (who can still browse the gallery).
drop policy if exists "app_config read for authenticated" on public.app_config;
create policy "app_config read for authenticated"
  on public.app_config for select
  to authenticated using (true);

drop policy if exists "app_config insert for authenticated" on public.app_config;
create policy "app_config insert for authenticated"
  on public.app_config for insert
  to authenticated with check (true);

drop policy if exists "app_config update for authenticated" on public.app_config;
create policy "app_config update for authenticated"
  on public.app_config for update
  to authenticated using (true) with check (true);
