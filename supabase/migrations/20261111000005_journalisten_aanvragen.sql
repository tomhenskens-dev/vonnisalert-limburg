-- Meerdere gevolgde journalisten (HBVL + HLN) en aanvragen om agendalijsten te laten checken

-- 1. Gevolgde journalisten
insert into public.app_state (key, value) values
  ('followed_authors', '[{"name":"Geert Houben","medium":"HBVL"},{"name":"Nienke Horemans","medium":"HLN"}]'::jsonb)
on conflict (key) do nothing;

drop policy if exists state_update on public.app_state;
create policy state_update on public.app_state for update to authenticated
  using (public.is_app_user() and key in ('rss_enabled','mail_enabled','reminder_enabled','only_geert','followed_authors'))
  with check (public.is_app_user() and key in ('rss_enabled','mail_enabled','reminder_enabled','only_geert','followed_authors'));

-- 2. Bron 'hln' toelaten bij dossiers
alter table public.cases drop constraint if exists cases_source_check;
alter table public.cases add constraint cases_source_check
  check (source in ('rss','hln','google','manueel','geplakt'));

-- 3. Aanvragen: lijst van evenementen die Claude moet opzoeken
create table if not exists public.agenda_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  target_year int not null default 2027 check (target_year between 2026 and 2035),
  content text not null check (length(content) between 3 and 20000),
  status text not null default 'wachtend' check (status in ('wachtend','verwerkt','mislukt')),
  result_note text check (length(result_note) <= 5000),
  processed_at timestamptz
);
alter table public.agenda_requests enable row level security;
drop policy if exists requests_all on public.agenda_requests;
create policy requests_all on public.agenda_requests for all to authenticated
  using (public.is_app_user()) with check (public.is_app_user());
revoke all on public.agenda_requests from anon;
grant select, insert, update, delete on public.agenda_requests to authenticated;
grant all on public.agenda_requests to service_role;

-- 4. Laatste automatische controle van de agenda bijhouden
alter table public.agenda_events add column if not exists checked_at timestamptz;

-- 5. Toegepaste updatebestanden (agenda/updates/*.json)
create table if not exists public.agenda_updates_applied (
  name text primary key,
  applied_at timestamptz not null default now()
);
alter table public.agenda_updates_applied enable row level security;
revoke all on public.agenda_updates_applied from anon, authenticated;
grant all on public.agenda_updates_applied to service_role;
